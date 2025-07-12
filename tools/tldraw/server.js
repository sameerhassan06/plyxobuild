const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.MAIN_APP_URL || 'http://localhost:3001',
    credentials: true
  }
});

// Serve TLDraw static files
app.use(express.static(path.join(__dirname, 'public')));

// SSO authentication endpoint
app.get('/auth/sso', (req, res) => {
  const { token } = req.query;
  
  try {
    const decoded = jwt.verify(token, process.env.SSO_SECRET || 'your-sso-secret');
    // Set session cookie
    res.cookie('tldraw_session', token, { httpOnly: true });
    res.redirect('/');
  } catch (err) {
    res.status(401).send('Invalid SSO token');
  }
});

// TLDraw page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket handling for real-time collaboration
const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, token }) => {
    try {
      const decoded = jwt.verify(token, process.env.SSO_SECRET || 'your-sso-secret');
      socket.userId = decoded.userId;
      socket.roomId = roomId;
      
      socket.join(roomId);
      
      // Initialize room if it doesn't exist
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          document: {},
          users: new Set()
        });
      }
      
      const room = rooms.get(roomId);
      room.users.add(socket.userId);
      
      // Send current document state
      socket.emit('document', room.document);
      
      // Notify others
      socket.to(roomId).emit('user-joined', {
        userId: socket.userId
      });
      
    } catch (err) {
      socket.emit('auth-error');
    }
  });
  
  socket.on('document-change', (changes) => {
    if (!socket.roomId) return;
    
    const room = rooms.get(socket.roomId);
    if (!room) return;
    
    // Update document
    room.document = { ...room.document, ...changes };
    
    // Broadcast to others in room
    socket.to(socket.roomId).emit('document-change', {
      changes,
      userId: socket.userId
    });
  });
  
  socket.on('disconnect', () => {
    if (socket.roomId && socket.userId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.users.delete(socket.userId);
        socket.to(socket.roomId).emit('user-left', {
          userId: socket.userId
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3002;
httpServer.listen(PORT, () => {
  console.log(`TLDraw service running on port ${PORT}`);
});