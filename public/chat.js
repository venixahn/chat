const API_URL = '/api';

const chatContainer = document.getElementById('chat-container');
const currentUsername = document.getElementById('current-username');
const logoutBtn = document.getElementById('logout-btn');
const usersList = document.getElementById('users-list');
const userSearch = document.getElementById('user-search');
const chatWithUser = document.getElementById('chat-with-user');
const backBtn = document.getElementById('back-btn');
const messagesContainer = document.getElementById('messages-container');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const charCount = document.getElementById('char-count');
const typingStatus = document.getElementById('typing-status');

const MAX_MESSAGE_LENGTH = 5000;

let currentChatUser = null;
let username = localStorage.getItem('username');
let socket = null;
let reconnectTimer = null;
let fallbackPoll = null;
let renderedMessageIds = new Set();
let renderedForUser = null;
let lastRenderedDate = null;
let onlineUsers = new Set();
let shuttingDown = false;
let typingThrottle = null;
let hideTypingTimer = null;

function clearSessionStorage() {
  localStorage.removeItem('token');
  localStorage.removeItem('username');
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (response.status === 401) {
    handleSessionExpiry();
    throw new Error('Unauthorized');
  }

  return response;
}

function handleSessionExpiry() {
  if (shuttingDown) return;
  shuttingDown = true;

  if (socket) {
    socket.close();
    socket = null;
  }
  clearTimeout(reconnectTimer);
  clearInterval(fallbackPoll);

  clearSessionStorage();
  alert('Your session has expired. Please login again.');
  window.location.href = '/index.html';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatDay(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Today';

  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

  return date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  });
}

function dayKey(timestamp) {
  return new Date(timestamp).toDateString();
}

function previewText(content) {
  const text = (content || '').replace(/\s+/g, ' ').trim();
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function setThreadOpen(open) {
  chatContainer.classList.toggle('thread-open', open);
}

function closeThread({ fromHistory = false } = {}) {
  currentChatUser = null;
  setThreadOpen(false);
  chatWithUser.textContent = 'Select a user to chat';
  messageInput.disabled = true;
  sendBtn.disabled = true;
  typingStatus.textContent = '';
  messagesContainer.innerHTML = `
    <div class="no-chat-selected">
      <p>Select a user from the sidebar to start chatting</p>
    </div>
  `;
  renderedMessageIds = new Set();
  renderedForUser = null;
  lastRenderedDate = null;
  document.querySelectorAll('.user-item').forEach((item) => {
    item.classList.remove('active');
  });
  if (!fromHistory && window.location.hash) {
    history.pushState({ chat: null }, '', window.location.pathname);
  }
}

logoutBtn.addEventListener('click', async () => {
  shuttingDown = true;
  if (socket) {
    socket.close();
    socket = null;
  }
  clearTimeout(reconnectTimer);
  clearInterval(fallbackPoll);

  try {
    await apiFetch('/logout', { method: 'POST' });
  } catch (error) {
    console.error('Logout error:', error);
  }

  clearSessionStorage();
  window.location.href = '/index.html';
});

backBtn.addEventListener('click', () => {
  closeThread();
});

window.addEventListener('popstate', () => {
  const user = window.location.hash.replace(/^#/, '');
  if (user) {
    selectUser(user, { fromHistory: true });
    return;
  }
  if (currentChatUser) {
    closeThread({ fromHistory: true });
  }
});

function applyUserFilter() {
  const query = (userSearch.value || '').trim().toLowerCase();
  let visible = 0;

  usersList.querySelectorAll('.user-item').forEach((item) => {
    const match = !query || item.dataset.username.toLowerCase().includes(query);
    item.hidden = !match;
    if (match) visible += 1;
  });

  const existingEmpty = usersList.querySelector('.no-users');
  const hasUsers = usersList.querySelectorAll('.user-item').length > 0;

  if (!hasUsers) {
    if (!existingEmpty) {
      usersList.insertAdjacentHTML('beforeend', '<p class="no-users">No other users registered</p>');
    }
    return;
  }

  if (existingEmpty) existingEmpty.remove();

  if (query && visible === 0) {
    usersList.insertAdjacentHTML('beforeend', '<p class="no-users">No users match that search</p>');
  }
}

userSearch.addEventListener('input', applyUserFilter);

function syncUserItem(item, user) {
  const nameEl = item.querySelector('.user-name');
  const previewEl = item.querySelector('.user-preview');
  const badge = item.querySelector('.unread-badge');

  nameEl.textContent = user.username;
  item.classList.toggle('active', user.username === currentChatUser);
  item.classList.toggle('online', onlineUsers.has(user.username));
  item.setAttribute('aria-pressed', user.username === currentChatUser ? 'true' : 'false');

  if (user.lastMessage) {
    const prefix = user.lastMessage.sender === username ? 'You: ' : '';
    previewEl.textContent = prefix + previewText(user.lastMessage.content);
    previewEl.classList.remove('hidden');
  } else {
    previewEl.textContent = '';
    previewEl.classList.add('hidden');
  }

  const count = user.unread || 0;
  if (count > 0 && user.username !== currentChatUser) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function createUserItem(user) {
  const userItem = document.createElement('div');
  userItem.className = 'user-item';
  userItem.dataset.username = user.username;
  userItem.tabIndex = 0;
  userItem.setAttribute('role', 'button');
  userItem.setAttribute('aria-pressed', 'false');
  userItem.innerHTML = `
    <div class="user-copy">
      <span class="user-name"></span>
      <span class="user-preview hidden"></span>
    </div>
    <span class="unread-badge hidden">0</span>
  `;
  syncUserItem(userItem, user);

  const open = () => selectUser(user.username);
  userItem.addEventListener('click', open);
  userItem.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });

  return userItem;
}

function renderUsers(users) {
  const existing = new Map();
  usersList.querySelectorAll('.user-item').forEach((item) => {
    existing.set(item.dataset.username, item);
  });

  usersList.querySelectorAll('.no-users').forEach((el) => el.remove());

  if (!users.length) {
    usersList.querySelectorAll('.user-item').forEach((item) => item.remove());
    usersList.innerHTML = '<p class="no-users">No other users registered</p>';
    return;
  }

  const incoming = new Set(users.map((user) => user.username));
  for (const [name, item] of existing) {
    if (!incoming.has(name)) {
      item.remove();
    }
  }

  users.forEach((user) => {
    const item = existing.get(user.username);
    if (item) {
      syncUserItem(item, user);
      usersList.appendChild(item);
      return;
    }
    usersList.appendChild(createUserItem(user));
  });

  applyUserFilter();
}

async function loadUsers() {
  try {
    const response = await apiFetch('/users');
    const data = await response.json();
    if (!response.ok) {
      console.error('Failed to load users:', data.error);
      return;
    }

    if (Array.isArray(data.online)) {
      onlineUsers = new Set(data.online);
    }
    renderUsers(data.users || []);
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      console.error('Error loading users:', error);
    }
  }
}

function appendDateSeparator(timestamp) {
  const key = dayKey(timestamp);
  if (key === lastRenderedDate) return;
  lastRenderedDate = key;

  const separator = document.createElement('div');
  separator.className = 'date-separator';
  separator.textContent = formatDay(timestamp);
  messagesContainer.appendChild(separator);
}

function createMessageEl(msg) {
  const messageDiv = document.createElement('div');
  const classes = ['message', msg.sender === username ? 'sent' : 'received'];
  if (msg.pending) classes.push('pending');
  if (msg.failed) classes.push('failed');
  messageDiv.className = classes.join(' ');
  messageDiv.dataset.messageId = msg.id;
  messageDiv.innerHTML = `
    <div class="message-content">
      <p>${escapeHtml(msg.content)}</p>
      <span class="message-time">${msg.pending ? 'Sending…' : escapeHtml(formatTime(msg.timestamp))}</span>
    </div>
  `;
  return messageDiv;
}

function consumeOptimistic(realMsg) {
  if (realMsg.sender !== username) return;

  const match = [...messagesContainer.querySelectorAll('.message.pending')].find((el) => {
    return el.querySelector('p')?.textContent === realMsg.content;
  });

  if (!match) return;

  renderedMessageIds.delete(match.dataset.messageId);
  match.remove();
}

function renderMessages(messages, { replace = false } = {}) {
  if (replace || renderedForUser !== currentChatUser) {
    messagesContainer.innerHTML = '';
    renderedMessageIds = new Set();
    renderedForUser = currentChatUser;
    lastRenderedDate = null;
  }

  if (!messages.length && renderedMessageIds.size === 0) {
    messagesContainer.innerHTML = `
      <div class="no-messages">
        <p>No messages yet. Start the conversation!</p>
      </div>
    `;
    return;
  }

  const empty = messagesContainer.querySelector('.no-messages, .no-chat-selected');
  if (empty && messages.length) {
    empty.remove();
  }

  const nearBottom =
    messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 80;

  messages.forEach((msg) => {
    if (!msg.id || renderedMessageIds.has(msg.id)) return;
    if (!msg.pending) {
      consumeOptimistic(msg);
    }
    renderedMessageIds.add(msg.id);
    appendDateSeparator(msg.timestamp);
    messagesContainer.appendChild(createMessageEl(msg));
  });

  if (nearBottom || replace) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

async function loadMessages(user, { replace = false } = {}) {
  try {
    const response = await apiFetch(`/messages/${encodeURIComponent(user)}`);
    const data = await response.json();
    if (!response.ok) {
      console.error('Failed to load messages:', data.error);
      return;
    }
    renderMessages(data.messages || [], { replace });
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      console.error('Error loading messages:', error);
    }
  }
}

async function markConversationRead(user) {
  try {
    await apiFetch(`/messages/${encodeURIComponent(user)}/read`, { method: 'POST' });
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      console.error('Error marking messages read:', error);
    }
  }
}

function selectUser(user, { fromHistory = false } = {}) {
  currentChatUser = user;
  setThreadOpen(true);
  chatWithUser.textContent = `Chat with ${user}`;
  messageInput.disabled = false;
  sendBtn.disabled = false;
  typingStatus.textContent = '';
  messageInput.focus();

  document.querySelectorAll('.user-item').forEach((item) => {
    const active = item.dataset.username === user;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (active) {
      const badge = item.querySelector('.unread-badge');
      if (badge) badge.classList.add('hidden');
    }
  });

  if (!fromHistory) {
    history.pushState({ chat: user }, '', `#${encodeURIComponent(user)}`);
  }

  loadMessages(user, { replace: true });
  markConversationRead(user);
}

function updateCharCount() {
  if (!charCount) return;
  const length = messageInput.value.length;
  charCount.textContent = length ? `${length} / ${MAX_MESSAGE_LENGTH}` : '';
  charCount.classList.toggle('over-limit', length > MAX_MESSAGE_LENGTH);
  messageInput.classList.toggle('invalid', length > MAX_MESSAGE_LENGTH);
}

function sendTypingNotice() {
  if (!currentChatUser || !socket || socket.readyState !== 1) return;
  if (typingThrottle) return;

  socket.send(JSON.stringify({ type: 'typing', to: currentChatUser }));
  typingThrottle = setTimeout(() => {
    typingThrottle = null;
  }, 1500);
}

function showTyping(from) {
  if (from !== currentChatUser) return;
  typingStatus.textContent = `${from} is typing…`;
  clearTimeout(hideTypingTimer);
  hideTypingTimer = setTimeout(() => {
    typingStatus.textContent = '';
  }, 2000);
}

function updateLocalPreview(content) {
  const item = document.querySelector(`[data-username="${currentChatUser}"]`);
  if (!item) return;
  const previewEl = item.querySelector('.user-preview');
  previewEl.textContent = `You: ${previewText(content)}`;
  previewEl.classList.remove('hidden');
  usersList.prepend(item);
}

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const content = messageInput.value.trim();
  if (!content || !currentChatUser) return;

  if (content.length > MAX_MESSAGE_LENGTH) {
    alert('Message must be less than 5000 characters');
    return;
  }

  const recipient = currentChatUser;
  const tempId = `temp-${crypto.randomUUID()}`;
  const optimistic = {
    id: tempId,
    sender: username,
    recipient,
    content,
    timestamp: new Date().toISOString(),
    pending: true
  };

  messageInput.value = '';
  updateCharCount();
  renderMessages([optimistic]);
  updateLocalPreview(content);

  try {
    const response = await apiFetch('/messages', {
      method: 'POST',
      body: JSON.stringify({ recipient, content })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to send message');
    }

    if (data.data) {
      renderMessages([data.data]);
    }
    loadUsers();
  } catch (error) {
    if (error.message === 'Unauthorized') return;

    const pending = document.querySelector(`[data-message-id="${tempId}"]`);
    if (pending) {
      pending.classList.remove('pending');
      pending.classList.add('failed');
      const time = pending.querySelector('.message-time');
      if (time) time.textContent = 'Failed';
    }

    messageInput.value = content;
    updateCharCount();
    console.error('Error sending message:', error);
    alert('Failed to send message: ' + (error.message || 'Unknown error'));
  }
});

messageInput.addEventListener('input', () => {
  updateCharCount();
  sendTypingNotice();
});

function handleSocketMessage(payload) {
  if (payload.type === 'message' && payload.message) {
    const msg = payload.message;
    const otherUser = msg.sender === username ? msg.recipient : msg.sender;

    if (currentChatUser === otherUser) {
      renderMessages([msg]);
      if (msg.recipient === username) {
        markConversationRead(otherUser);
      }
    }

    loadUsers();
    return;
  }

  if (payload.type === 'users_changed') {
    loadUsers();
    return;
  }

  if (payload.type === 'presence' && Array.isArray(payload.online)) {
    onlineUsers = new Set(payload.online);
    document.querySelectorAll('.user-item').forEach((item) => {
      item.classList.toggle('online', onlineUsers.has(item.dataset.username));
    });
    return;
  }

  if (payload.type === 'typing' && payload.from) {
    showTyping(payload.from);
    return;
  }

  if (payload.type === 'unread') {
    loadUsers();
  }
}

function connectSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  socket.addEventListener('open', () => {
    clearInterval(fallbackPoll);
    fallbackPoll = null;
  });

  socket.addEventListener('message', (event) => {
    try {
      handleSocketMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('Invalid socket message:', error);
    }
  });

  socket.addEventListener('close', (event) => {
    socket = null;
    if (shuttingDown) return;
    if (event.code === 4401) {
      handleSessionExpiry();
      return;
    }
    if (!fallbackPoll) {
      fallbackPoll = setInterval(() => {
        loadUsers();
        if (currentChatUser) {
          loadMessages(currentChatUser);
        }
      }, 15000);
    }
    reconnectTimer = setTimeout(connectSocket, 3000);
  });
}

async function init() {
  try {
    const response = await apiFetch('/me');
    const data = await response.json();
    if (!response.ok) {
      handleSessionExpiry();
      return;
    }

    username = data.username;
    localStorage.setItem('username', username);
    localStorage.removeItem('token');
    currentUsername.textContent = username;
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      handleSessionExpiry();
    }
    return;
  }

  await loadUsers();
  connectSocket();

  const hashedUser = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  if (hashedUser) {
    selectUser(hashedUser, { fromHistory: true });
  }
}

init();

window.addEventListener('beforeunload', () => {
  clearTimeout(reconnectTimer);
  clearInterval(fallbackPoll);
  if (socket) {
    socket.close();
  }
});
