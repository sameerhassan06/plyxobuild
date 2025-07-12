const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
const Redis = require('redis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost',
    credentials: true
  }
});

// Database setup
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://designhub_user:designhub_pass@postgres/designhub'
});

// Redis setup (optional for now)
const redisClient = Redis.createClient({
  url: process.env.REDIS_URL || 'redis://redis:6379'
}).on('error', err => console.log('Redis Client Error', err));

// Connect Redis
redisClient.connect().catch(console.error);

// Middleware
app.use(cors({ 
  credentials: true, 
  origin: ['http://localhost', 'http://localhost:3000', 'http://localhost:80']
}));
app.use(express.json());

// Create tables
async function createTables() {
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        is_admin BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        tools TEXT[],
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS tool_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        project_id UUID REFERENCES projects(id),
        tool_name VARCHAR(50),
        token TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Database tables created');
  } catch (err) {
    console.error('Database error:', err);
  }
}

// JWT middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }
  
  jwt.verify(token, process.env.JWT_SECRET || 'secret', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
}

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Authentication routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    // Validate input
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    // Check if user exists
    const existingUser = await pgPool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
    const result = await pgPool.query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at',
      [email, hashedPassword, name]
    );
    
    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
    
    res.json({ user, token });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Get user
    const result = await pgPool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Check password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const token = jwt.sign(
      { userId: user.id, email: user.email }, 
      process.env.JWT_SECRET || 'secret', 
      { expiresIn: '7d' }
    );
    
    res.json({ 
      user: { 
        id: user.id, 
        email: user.email, 
        name: user.name,
        is_admin: user.is_admin 
      }, 
      token 
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await pgPool.query(
      'SELECT id, email, name, is_admin, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

app.put('/api/auth/profile', authenticateToken, async (req, res) => {
  try {
    const { name } = req.body;
    
    const result = await pgPool.query(
      'UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, name, is_admin',
      [name, req.user.userId]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Project routes
app.get('/api/projects', authenticateToken, async (req, res) => {
  try {
    const result = await pgPool.query(
      'SELECT * FROM projects WHERE user_id = $1 ORDER BY updated_at DESC',
      [req.user.userId]
    );
    
    res.json(result.rows);
  } catch (err) {
    console.error('Get projects error:', err);
    res.status(500).json({ error: 'Failed to get projects' });
  }
});

app.post('/api/projects', authenticateToken, async (req, res) => {
  try {
    const { name, tools } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    
    const result = await pgPool.query(
      'INSERT INTO projects (name, user_id, tools) VALUES ($1, $2, $3) RETURNING *',
      [name, req.user.userId, tools || []]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Create project error:', err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

app.get('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pgPool.query(
      'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get project error:', err);
    res.status(500).json({ error: 'Failed to get project' });
  }
});

app.put('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const { name, tools } = req.body;
    
    const result = await pgPool.query(
      'UPDATE projects SET name = COALESCE($1, name), tools = COALESCE($2, tools), updated_at = NOW() WHERE id = $3 AND user_id = $4 RETURNING *',
      [name, tools, req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update project error:', err);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

app.delete('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pgPool.query(
      'DELETE FROM projects WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Delete project error:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// Tool integration routes
app.post('/api/tools/launch', authenticateToken, async (req, res) => {
  try {
    const { toolName, projectId } = req.body;
    
    // Generate SSO token for the tool
    const ssoToken = jwt.sign(
      { 
        userId: req.user.userId, 
        projectId,
        toolName,
        timestamp: Date.now()
      },
      process.env.SSO_SECRET || 'sso-secret',
      { expiresIn: '1h' }
    );
    
    // Store session
    await pgPool.query(
      'INSERT INTO tool_sessions (user_id, project_id, tool_name, token) VALUES ($1, $2, $3, $4)',
      [req.user.userId, projectId, toolName, ssoToken]
    );
    
    // Return appropriate URLs based on tool
    const toolUrls = {
      prototyper: {
        url: `http://localhost:9001/auth/sso?token=${ssoToken}`,
        embedUrl: `http://localhost:9001?sso=${ssoToken}`
      },
      whiteboard: {
        url: `http://localhost:3002/auth/sso?token=${ssoToken}&room=${projectId}`,
        embedUrl: `http://localhost:3002?token=${ssoToken}&room=${projectId}`
      },
      sitebuilder: {
        url: `http://localhost:3003/auth/sso?token=${ssoToken}&project=${projectId}`,
        embedUrl: `http://localhost:3003?token=${ssoToken}&project=${projectId}`
      }
    };
    
    res.json(toolUrls[toolName] || { url: '#', embedUrl: '#' });
  } catch (err) {
    console.error('Launch tool error:', err);
    res.status(500).json({ error: 'Failed to launch tool' });
  }
});

// SSO verification endpoint for tools
app.get('/api/auth/sso/verify', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }
    
    const decoded = jwt.verify(token, process.env.SSO_SECRET || 'sso-secret');
    
    // Get user info
    const result = await pgPool.query(
      'SELECT id, email, name FROM users WHERE id = $1',
      [decoded.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
      user: result.rows[0],
      projectId: decoded.projectId,
      toolName: decoded.toolName
    });
  } catch (err) {
    console.error('SSO verify error:', err);
    res.status(401).json({ error: 'Invalid token' });
  }
});

// WebSocket for real-time features
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
      socket.userId = decoded.userId;
      socket.join(`user-${decoded.userId}`);
      socket.emit('authenticated');
    } catch (err) {
      socket.emit('auth-error');
      socket.disconnect();
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, async () => {
  await createTables();
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 API available at http://localhost:${PORT}/api`);
});