const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6
});

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'database.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function formatTimestamp(date = new Date()) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const DEFAULT_DB = {
  accounts: {},
  sessions: {},
  channels: [
    {
      id: '#general',
      name: 'general',
      topic: 'Main KCTC Hub classroom lobby — announcements, links, and general discussion.'
    },
    {
      id: '#kctc-projects',
      name: 'kctc-projects',
      topic: 'Share code snippets, lab assignments, and project collaborations.'
    },
    {
      id: '#hardware-and-tech',
      name: 'hardware-and-tech',
      topic: 'PC builds, networking labs, benchmarks, and troubleshooting.'
    },
    {
      id: '#break-room',
      name: 'break-room',
      topic: 'Off-topic chat, gaming lobbies, and memes.'
    }
  ],
  messagesByChannel: {
    '#general': [
      {
        id: 'msg-welcome-1',
        channelId: '#general',
        authorUsername: 'KCTC System',
        authorRole: 'owner',
        avatarColor: '#5865f2',
        content: 'Welcome to **KCTC Hub (KCTC Connect)**! Accounts, roles, channels, and direct messages are permanently saved in `database.json`.',
        timestamp: `Today at ${formatTimestamp()}`,
        replyTo: null,
        reactions: { '🚀': ['KCTC System'], '🔥': ['KCTC System'] }
      }
    ],
    '#kctc-projects': [],
    '#hardware-and-tech': [],
    '#break-room': []
  },
  directMessages: {}
};

function loadDatabase() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2), 'utf8');
      return JSON.parse(JSON.stringify(DEFAULT_DB));
    }
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      accounts: parsed.accounts || {},
      sessions: parsed.sessions || {},
      channels: parsed.channels || DEFAULT_DB.channels,
      messagesByChannel: parsed.messagesByChannel || DEFAULT_DB.messagesByChannel,
      directMessages: parsed.directMessages || {}
    };
  } catch (err) {
    console.error('Error loading database.json, initializing fresh state:', err);
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

const db = loadDatabase();

function saveDatabase() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write database.json:', err);
  }
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 10000, 64, 'sha512').toString('hex');
}

function getDmThreadKey(userA, userB) {
  return [String(userA).toLowerCase(), String(userB).toLowerCase()].sort().join('__');
}

const activeSockets = new Map();

const voiceRooms = {
  'KCTC Main Voice': [],
  'Study & Pair Coding': [],
  'Gaming & Lounge': []
};

function getPublicUsersDirectory() {
  const onlineByLower = new Map();
  for (const sess of activeSockets.values()) {
    onlineByLower.set(sess.usernameLower, sess);
  }

  return Object.values(db.accounts).map((acc) => {
    const key = acc.username.toLowerCase();
    const live = onlineByLower.get(key);
    return {
      username: acc.username,
      role: acc.role,
      avatarColor: acc.avatarColor,
      online: !!live,
      status: live ? live.status : 'offline',
      inVoiceRoom: live ? live.inVoiceRoom : null,
      isSpeaking: live ? live.isSpeaking : false
    };
  });
}

function getSerializedVoiceRooms() {
  const result = {};
  for (const [roomName, socketIds] of Object.entries(voiceRooms)) {
    result[roomName] = socketIds
      .map((sid) => activeSockets.get(sid))
      .filter(Boolean)
      .map((u) => ({
        socketId: u.socketId,
        username: u.username,
        role: u.role,
        avatarColor: u.avatarColor,
        isMuted: u.isMuted,
        isDeafened: u.isDeafened,
        isSpeaking: u.isSpeaking,
        hasVideo: u.hasVideo,
        isScreenSharing: u.isScreenSharing
      }));
  }
  return result;
}

function removeSocketFromVoiceRooms(socketId) {
  let leftRoom = null;
  for (const [roomName, list] of Object.entries(voiceRooms)) {
    const idx = list.indexOf(socketId);
    if (idx !== -1) {
      list.splice(idx, 1);
      leftRoom = roomName;
    }
  }
  const sess = activeSockets.get(socketId);
  if (sess) {
    sess.inVoiceRoom = null;
    sess.isSpeaking = false;
    sess.hasVideo = false;
    sess.isScreenSharing = false;
  }
  return leftRoom;
}

function emitDirectoryAndVoice() {
  io.emit('directory:update', getPublicUsersDirectory());
  io.emit('voice:update', getSerializedVoiceRooms());
}

io.on('connection', (socket) => {
  function completeSocketLogin(account, token) {
    const usernameLower = account.username.toLowerCase();

    if (usernameLower === 'goffglazer' && account.role !== 'owner') {
      account.role = 'owner';
      saveDatabase();
    }

    const sessionUser = {
      socketId: socket.id,
      username: account.username,
      usernameLower,
      role: account.role,
      avatarColor: account.avatarColor || '#5865f2',
      status: 'online',
      inVoiceRoom: null,
      isMuted: false,
      isDeafened: false,
      isSpeaking: false,
      hasVideo: false,
      isScreenSharing: false
    };

    activeSockets.set(socket.id, sessionUser);

    socket.emit('auth:success', {
      token,
      self: {
        username: account.username,
        role: account.role,
        avatarColor: account.avatarColor,
        status: 'online'
      },
      channels: db.channels,
      messagesByChannel: db.messagesByChannel,
      directory: getPublicUsersDirectory(),
      voiceRooms: getSerializedVoiceRooms()
    });

    emitDirectoryAndVoice();
  }

  socket.on('auth:register', (payload) => {
    const rawUsername = String(payload?.username || '').trim();
    const password = String(payload?.password || '');
    const avatarColor = payload?.avatarColor || '#5865f2';

    if (!/^[a-zA-Z0-9_.-]{2,24}$/.test(rawUsername)) {
      return socket.emit('auth:error', 'Username must be 2–24 characters (letters, numbers, _ . -).');
    }
    if (password.length < 3) {
      return socket.emit('auth:error', 'Password must be at least 3 characters.');
    }

    const usernameLower = rawUsername.toLowerCase();
    if (db.accounts[usernameLower]) {
      return socket.emit('auth:error', 'That username is already registered. Please switch to Login.');
    }

    const isFirstAccount = Object.keys(db.accounts).length === 0;
    const isGoffGlazer = usernameLower === 'goffglazer';
    const assignedRole = isFirstAccount || isGoffGlazer ? 'owner' : 'member';

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);

    const newAccount = {
      username: rawUsername,
      passwordHash,
      salt,
      role: assignedRole,
      avatarColor,
      createdAt: new Date().toISOString()
    };

    db.accounts[usernameLower] = newAccount;
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = usernameLower;
    saveDatabase();

    completeSocketLogin(newAccount, token);
  });

  socket.on('auth:login', (payload) => {
    const rawUsername = String(payload?.username || '').trim();
    const password = String(payload?.password || '');
    const usernameLower = rawUsername.toLowerCase();

    const account = db.accounts[usernameLower];
    if (!account) {
      return socket.emit('auth:error', 'Account not found. Check your username or Register a new account.');
    }

    const computedHash = hashPassword(password, account.salt);
    if (computedHash !== account.passwordHash) {
      return socket.emit('auth:error', 'Incorrect password for this account.');
    }

    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = usernameLower;
    saveDatabase();

    completeSocketLogin(account, token);
  });

  socket.on('auth:resume', ({ token }) => {
    if (!token || !db.sessions[token]) {
      return socket.emit('auth:expired');
    }
    const usernameLower = db.sessions[token];
    const account = db.accounts[usernameLower];
    if (!account) {
      return socket.emit('auth:expired');
    }
    completeSocketLogin(account, token);
  });

  socket.on('auth:logout', ({ token }) => {
    if (token && db.sessions[token]) {
      delete db.sessions[token];
      saveDatabase();
    }
    const leftRoom = removeSocketFromVoiceRooms(socket.id);
    if (leftRoom && voiceRooms[leftRoom]) {
      voiceRooms[leftRoom].forEach((peerSid) => {
        io.to(peerSid).emit('voice:peer-left', { peerId: socket.id });
      });
    }
    activeSockets.delete(socket.id);
    emitDirectoryAndVoice();
  });

  socket.on('admin:set-role', ({ targetUsername, newRole }) => {
    const actor = activeSockets.get(socket.id);
    if (!actor) return;

    if (actor.role !== 'owner' && actor.role !== 'mod') {
      return socket.emit('system:toast', {
        type: 'error',
        message: 'Permission denied: Only Owners and Moderators can modify roles.'
      });
    }

    if (!['mod', 'member'].includes(newRole)) return;

    const targetLower = String(targetUsername || '').toLowerCase();
    const targetAccount = db.accounts[targetLower];
    if (!targetAccount) return;

    if (targetAccount.role === 'owner') {
      return socket.emit('system:toast', {
        type: 'error',
        message: 'Server Owners cannot be demoted.'
      });
    }

    if (actor.role === 'mod' && targetAccount.role === 'mod' && newRole === 'member') {
      return socket.emit('system:toast', {
        type: 'error',
        message: 'Only the Server Owner can demote an existing Moderator.'
      });
    }

    targetAccount.role = newRole;
    saveDatabase();

    for (const sess of activeSockets.values()) {
      if (sess.usernameLower === targetLower) {
        sess.role = newRole;
        io.to(sess.socketId).emit('auth:role-updated', { role: newRole });
      }
    }

    emitDirectoryAndVoice();
    io.emit('system:toast', {
      type: 'info',
      message: `${actor.username} updated ${targetAccount.username}'s role to ${newRole.toUpperCase()}.`
    });
  });

  socket.on('channel:create', ({ name, topic }) => {
    const actor = activeSockets.get(socket.id);
    if (!actor || (actor.role !== 'owner' && actor.role !== 'mod')) {
      return socket.emit('system:toast', {
        type: 'error',
        message: 'Only Owners and Moderators can create new public channels.'
      });
    }

    const cleanName = String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .slice(0, 24);
    if (!cleanName) return;

    const channelId = `#${cleanName}`;
    if (db.channels.some((c) => c.id === channelId)) return;

    const newChannel = {
      id: channelId,
      name: cleanName,
      topic: String(topic || `KCTC channel for ${channelId}`).slice(0, 120)
    };

    db.channels.push(newChannel);
    db.messagesByChannel[channelId] = [];
    saveDatabase();

    io.emit('channel:created', newChannel);
  });

  socket.on('message:send', (payload) => {
    const sender = activeSockets.get(socket.id);
    if (!sender) return;

    const channelId = String(payload?.channelId || '#general');
    const content = String(payload?.content || '').trim();
    if (!content) return;

    const msgObj = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      channelId,
      authorUsername: sender.username,
      authorRole: sender.role,
      avatarColor: sender.avatarColor,
      content: content.slice(0, 2000),
      timestamp: `Today at ${formatTimestamp()}`,
      replyTo: payload?.replyTo || null,
      reactions: {}
    };

    if (!db.messagesByChannel[channelId]) {
      db.messagesByChannel[channelId] = [];
    }
    db.messagesByChannel[channelId].push(msgObj);
    if (db.messagesByChannel[channelId].length > 300) {
      db.messagesByChannel[channelId].shift();
    }
    saveDatabase();

    io.emit('message:new', { channelId, message: msgObj });
  });

  socket.on('message:delete', ({ isDm, targetId, messageId }) => {
    const actor = activeSockets.get(socket.id);
    if (!actor) return;

    if (isDm) {
      const dmKey = getDmThreadKey(actor.username, targetId);
      const list = db.directMessages[dmKey] || [];
      const msg = list.find((m) => m.id === messageId);
      if (!msg) return;

      const canDelete =
        msg.authorUsername.toLowerCase() === actor.usernameLower ||
        actor.role === 'owner' ||
        actor.role === 'mod';

      if (!canDelete) return;

      db.directMessages[dmKey] = list.filter((m) => m.id !== messageId);
      saveDatabase();

      const targetLower = String(targetId).toLowerCase();
      for (const sess of activeSockets.values()) {
        if (sess.usernameLower === actor.usernameLower || sess.usernameLower === targetLower) {
          io.to(sess.socketId).emit('message:deleted', {
            isDm: true,
            dmKey,
            messageId
          });
        }
      }
    } else {
      const channelId = targetId;
      const list = db.messagesByChannel[channelId] || [];
      const msg = list.find((m) => m.id === messageId);
      if (!msg) return;

      const canDelete =
        msg.authorUsername.toLowerCase() === actor.usernameLower ||
        actor.role === 'owner' ||
        actor.role === 'mod';

      if (!canDelete) {
        return socket.emit('system:toast', {
          type: 'error',
          message: 'You can only delete your own messages.'
        });
      }

      db.messagesByChannel[channelId] = list.filter((m) => m.id !== messageId);
      saveDatabase();

      io.emit('message:deleted', {
        isDm: false,
        channelId,
        messageId
      });
    }
  });

  socket.on('message:react', ({ isDm, targetId, messageId, emoji }) => {
    const actor = activeSockets.get(socket.id);
    if (!actor) return;

    if (isDm) {
      const dmKey = getDmThreadKey(actor.username, targetId);
      const list = db.directMessages[dmKey] || [];
      const msg = list.find((m) => m.id === messageId);
      if (!msg) return;

      if (!msg.reactions) msg.reactions = {};
      if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

      const idx = msg.reactions[emoji].indexOf(actor.username);
      if (idx === -1) {
        msg.reactions[emoji].push(actor.username);
      } else {
        msg.reactions[emoji].splice(idx, 1);
        if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
      }
      saveDatabase();

      const targetLower = String(targetId).toLowerCase();
      for (const sess of activeSockets.values()) {
        if (sess.usernameLower === actor.usernameLower || sess.usernameLower === targetLower) {
          io.to(sess.socketId).emit('message:updated', { isDm: true, dmKey, message: msg });
        }
      }
    } else {
      const channelId = targetId;
      const list = db.messagesByChannel[channelId] || [];
      const msg = list.find((m) => m.id === messageId);
      if (!msg) return;

      if (!msg.reactions) msg.reactions = {};
      if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

      const idx = msg.reactions[emoji].indexOf(actor.username);
      if (idx === -1) {
        msg.reactions[emoji].push(actor.username);
      } else {
        msg.reactions[emoji].splice(idx, 1);
        if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
      }
      saveDatabase();

      io.emit('message:updated', { isDm: false, channelId, message: msg });
    }
  });

  socket.on('dm:fetch', ({ peerUsername }) => {
    const sender = activeSockets.get(socket.id);
    if (!sender || !peerUsername) return;
    const dmKey = getDmThreadKey(sender.username, peerUsername);
    const messages = db.directMessages[dmKey] || [];
    socket.emit('dm:history', {
      peerUsername,
      dmKey,
      messages
    });
  });

  socket.on('dm:send', (payload) => {
    const sender = activeSockets.get(socket.id);
    if (!sender) return;

    const peerUsername = String(payload?.peerUsername || '').trim();
    const content = String(payload?.content || '').trim();
    if (!peerUsername || !content) return;

    const dmKey = getDmThreadKey(sender.username, peerUsername);
    if (!db.directMessages[dmKey]) {
      db.directMessages[dmKey] = [];
    }

    const dmMessage = {
      id: `dm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      dmKey,
      fromUsername: sender.username,
      toUsername: peerUsername,
      authorUsername: sender.username,
      authorRole: sender.role,
      avatarColor: sender.avatarColor,
      content: content.slice(0, 2000),
      timestamp: `Today at ${formatTimestamp()}`,
      replyTo: payload?.replyTo || null,
      reactions: {}
    };

    db.directMessages[dmKey].push(dmMessage);
    if (db.directMessages[dmKey].length > 300) {
      db.directMessages[dmKey].shift();
    }
    saveDatabase();

    const peerLower = peerUsername.toLowerCase();
    for (const sess of activeSockets.values()) {
      if (sess.usernameLower === sender.usernameLower || sess.usernameLower === peerLower) {
        io.to(sess.socketId).emit('dm:new', {
          dmKey,
          peerUsername:
            sess.usernameLower === sender.usernameLower ? peerUsername : sender.username,
          message: dmMessage
        });
      }
    }
  });

  socket.on('voice:join', ({ roomName, hasVideo, isScreenSharing }) => {
    const user = activeSockets.get(socket.id);
    if (!user || !voiceRooms[roomName]) return;

    const prevRoom = removeSocketFromVoiceRooms(socket.id);
    if (prevRoom && voiceRooms[prevRoom]) {
      voiceRooms[prevRoom].forEach((peerSid) => {
        io.to(peerSid).emit('voice:peer-left', { peerId: socket.id });
      });
    }

    const existingPeerSocketIds = [...voiceRooms[roomName]];
    voiceRooms[roomName].push(socket.id);
    user.inVoiceRoom = roomName;
    user.hasVideo = !!hasVideo;
    user.isScreenSharing = !!isScreenSharing;

    socket.emit('voice:existing-peers', {
      roomName,
      peers: existingPeerSocketIds
        .map((sid) => activeSockets.get(sid))
        .filter(Boolean)
    });

    existingPeerSocketIds.forEach((peerSid) => {
      io.to(peerSid).emit('voice:peer-joined', {
        roomName,
        peer: user
      });
    });

    emitDirectoryAndVoice();
  });

  socket.on('voice:leave', () => {
    const leftRoom = removeSocketFromVoiceRooms(socket.id);
    if (leftRoom && voiceRooms[leftRoom]) {
      voiceRooms[leftRoom].forEach((peerSid) => {
        io.to(peerSid).emit('voice:peer-left', { peerId: socket.id });
      });
    }
    emitDirectoryAndVoice();
  });

  socket.on('voice:media-state', (stateUpdate) => {
    const user = activeSockets.get(socket.id);
    if (!user) return;
    if (typeof stateUpdate.isMuted === 'boolean') user.isMuted = stateUpdate.isMuted;
    if (typeof stateUpdate.isDeafened === 'boolean') user.isDeafened = stateUpdate.isDeafened;
    if (typeof stateUpdate.isSpeaking === 'boolean') user.isSpeaking = stateUpdate.isSpeaking;
    if (typeof stateUpdate.hasVideo === 'boolean') user.hasVideo = stateUpdate.hasVideo;
    if (typeof stateUpdate.isScreenSharing === 'boolean') {
      user.isScreenSharing = stateUpdate.isScreenSharing;
    }
    emitDirectoryAndVoice();
  });

  socket.on('webrtc:offer', ({ targetId, sdp }) => {
    const sender = activeSockets.get(socket.id);
    io.to(targetId).emit('webrtc:offer', {
      fromId: socket.id,
      fromUser: sender,
      sdp
    });
  });

  socket.on('webrtc:answer', ({ targetId, sdp }) => {
    io.to(targetId).emit('webrtc:answer', {
      fromId: socket.id,
      sdp
    });
  });

  socket.on('webrtc:ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc:ice-candidate', {
      fromId: socket.id,
      candidate
    });
  });

  socket.on('disconnect', () => {
    const leftRoom = removeSocketFromVoiceRooms(socket.id);
    if (leftRoom && voiceRooms[leftRoom]) {
      voiceRooms[leftRoom].forEach((peerSid) => {
        io.to(peerSid).emit('voice:peer-left', { peerId: socket.id });
      });
    }
    activeSockets.delete(socket.id);
    emitDirectoryAndVoice();
  });
});

function getLocalIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLocalIPv4();
  console.log('\n============================================================');
  console.log('  ⚡ KCTC HUB / KCTC CONNECT SERVER IS RUNNING');
  console.log('============================================================');
  console.log(`  Local URL:       http://localhost:${PORT}`);
  console.log(`  LAN Switch URL:  http://${lanIp}:${PORT}`);
  console.log(`  Database File:   ${DB_PATH}`);
  console.log('============================================================\n');
});
