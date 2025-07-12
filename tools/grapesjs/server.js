const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SSO authentication
app.get('/auth/sso', (req, res) => {
  const { token, project } = req.query;
  
  try {
    const decoded = jwt.verify(token, process.env.SSO_SECRET || 'your-sso-secret');
    res.cookie('grapesjs_session', token, { httpOnly: true });
    res.cookie('project_id', project, { httpOnly: true });
    res.redirect('/');
  } catch (err) {
    res.status(401).send('Invalid SSO token');
  }
});

// Main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Save project
app.post('/api/save', async (req, res) => {
  try {
    const token = req.cookies.grapesjs_session;
    const projectId = req.cookies.project_id;
    
    const decoded = jwt.verify(token, process.env.SSO_SECRET || 'your-sso-secret');
    
    // Save to main API
    await axios.post(
      `${process.env.MAIN_APP_URL}/api/grapesjs/${projectId}/save`,
      req.body,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Load project
app.get('/api/load', async (req, res) => {
  try {
    const token = req.cookies.grapesjs_session;
    const projectId = req.cookies.project_id;
    
    const response = await axios.get(
      `${process.env.MAIN_APP_URL}/api/grapesjs/${projectId}/load`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );
    
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`GrapesJS service running on port ${PORT}`);
});