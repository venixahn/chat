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
const connectionBanner = document.getElementById('connection-banner');
const toastRegion = document.getElementById('toast-region');
const jumpLatest = document.getElementById('jump-latest');
const composerHint = document.getElementById('composer-hint');

const MAX_MESSAGE_LENGTH = 5000;
const CHAR_COUNT_REVEAL_AT = 4000;
const COMPOSER_MAX_HEIGHT = 120;
const GROUP_WINDOW_MS = 5 * 60 * 1000;
const BASE_TITLE = 'Chat - Chat App';

let currentChatUser = null;
let username = localStorage.getItem('username');
let socket = null;
let reconnectTimer = null;
let fallbackPoll = null;
let renderedMessageIds = new Set();
let renderedForUser = null;
let lastRenderedDate = null;
let lastRenderedSender = null;
let lastRenderedTimestamp = null;
let onlineUsers = new Set();
let shuttingDown = false;
let typingThrottle = null;
let hideTypingTimer = null;
let toastTimer = null;
let hiddenIncoming = 0;
let backgroundUnread = 0;
let notificationAsked = false;

function clearSessionStorage() {
  localStorage.removeItem('token');
  localStorage.removeItem('username');
}

function showToast(message, tone = 'info') {
  if (!toastRegion) return;
  toastRegion.textContent = message;
  toastRegion.className = `toast-region toast-visible toast-${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastRegion.classList.remove('toast-visible');
  }, 4000);
}

function setConnectionState(state) {
  if (connectionBanner) {
    if (state === 'open') {
      connectionBanner.classList.add('hidden');
      connectionBanner.textContent = '';
    } else {
      connectionBanner.classList.remove('hidden');
      connectionBanner.textContent = state === 'offline'
        ? 'Offline. Trying to reconnect…'
        : 'Reconnecting…';
    }
  }

  if (composerHint) {
    if (state === 'open') {
      composerHint.textContent = '';
      composerHint.classList.add('hidden');
    } else {
      composerHint.classList.remove('hidden');
      composerHint.textContent = state === 'offline'
        ? "You're offline. You can still type; sending may fail until you're back."
        : 'Reconnecting… incoming messages may be delayed.';
    }
  }

  chatContainer.classList.toggle('disconnected', state !== 'open');
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
  showToast('Your session expired. Redirecting to login…', 'error');
  setTimeout(() => {
    window.location.href = '/index.html';
  }, 1200);
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

function formatListTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return formatTime(timestamp);
  }

  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }

  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
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

function initialsFor(name) {
  const clean = (name || '').trim();
  if (!clean) return '?';
  const parts = clean.split(/[_\s]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 52%, 46%)`;
}

function setThreadOpen(open) {
  chatContainer.classList.toggle('thread-open', open);
}

function emptyChatSelectedHtml() {
  return `
    <div class="empty-state no-chat-selected">
      <p class="empty-title">Pick a conversation</p>
      <p>Choose someone in the list to start chatting. New accounts show up here after they sign up.</p>
    </div>
  `;
}

function emptyNoMessagesHtml(user) {
  return `
    <div class="empty-state no-messages">
      <p class="empty-title">No messages yet</p>
      <p>Say hello to ${escapeHtml(user)}. Enter sends, Shift+Enter starts a new line.</p>
    </div>
  `;
}

function emptyNoUsersHtml() {
  return `
    <div class="empty-state no-users">
      <p class="empty-title">You're the only one here</p>
      <p>Open this app in another browser and create a second account, or ask a friend to sign up.</p>
    </div>
  `;
}

function isNearBottom() {
  return messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 80;
}

function hideJumpLatest() {
  hiddenIncoming = 0;
  if (jumpLatest) jumpLatest.classList.add('hidden');
}

function showJumpLatest() {
  hiddenIncoming += 1;
  if (!jumpLatest) return;
  jumpLatest.textContent = hiddenIncoming === 1 ? '1 new message' : `${hiddenIncoming} new messages`;
  jumpLatest.classList.remove('hidden');
}

function scrollToLatest() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  hideJumpLatest();
}

function updateTitleCount() {
  document.title = document.hidden && backgroundUnread > 0
    ? `(${backgroundUnread}) ${BASE_TITLE}`
    : BASE_TITLE;
}

function notifyIncoming(msg) {
  if (!msg || msg.sender === username || !document.hidden) return;

  backgroundUnread += 1;
  updateTitleCount();

  if (!('Notification' in window)) return;

  if (Notification.permission === 'granted') {
    new Notification(msg.sender, {
      body: previewText(msg.content),
      tag: 'chat-incoming'
    });
    return;
  }

  if (Notification.permission === 'default' && !notificationAsked) {
    notificationAsked = true;
    Notification.requestPermission();
  }
}

function resizeComposer() {
  messageInput.style.height = 'auto';
  const next = Math.min(messageInput.scrollHeight, COMPOSER_MAX_HEIGHT);
  messageInput.style.height = `${next}px`;
  messageInput.style.overflowY = messageInput.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
}

function closeThread({ fromHistory = false } = {}) {
  currentChatUser = null;
  setThreadOpen(false);
  chatWithUser.textContent = 'Select a user to chat';
  messageInput.disabled = true;
  sendBtn.disabled = true;
  typingStatus.textContent = '';
  messageInput.value = '';
  resizeComposer();
  updateCharCount();
  messagesContainer.innerHTML = emptyChatSelectedHtml();
  renderedMessageIds = new Set();
  renderedForUser = null;
  lastRenderedDate = null;
  lastRenderedSender = null;
  lastRenderedTimestamp = null;
  hideJumpLatest();
  document.querySelectorAll('.user-item').forEach((item) => {
    item.classList.remove('active');
    item.setAttribute('aria-pressed', 'false');
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
      usersList.insertAdjacentHTML('beforeend', emptyNoUsersHtml());
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
  const timeEl = item.querySelector('.user-time');
  const badge = item.querySelector('.unread-badge');
  const avatar = item.querySelector('.user-avatar');

  nameEl.textContent = user.username;
  avatar.textContent = initialsFor(user.username);
  avatar.style.background = avatarColor(user.username);
  item.classList.toggle('active', user.username === currentChatUser);
  item.classList.toggle('online', onlineUsers.has(user.username));
  item.setAttribute('aria-pressed', user.username === currentChatUser ? 'true' : 'false');

  if (user.lastMessage) {
    const prefix = user.lastMessage.sender === username ? 'You: ' : '';
    previewEl.textContent = prefix + previewText(user.lastMessage.content);
    previewEl.classList.remove('hidden');
    timeEl.textContent = formatListTime(user.lastMessage.timestamp);
  } else {
    previewEl.textContent = 'No messages yet';
    previewEl.classList.remove('hidden');
    timeEl.textContent = '';
  }

  const count = user.unread || 0;
  const unread = count > 0 && user.username !== currentChatUser;
  item.classList.toggle('unread', unread);
  if (unread) {
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
    <div class="user-avatar" aria-hidden="true"></div>
    <div class="user-copy">
      <div class="user-row-top">
        <span class="user-name"></span>
        <span class="user-time"></span>
      </div>
      <div class="user-row-bottom">
        <span class="user-preview hidden"></span>
        <span class="unread-badge hidden">0</span>
      </div>
    </div>
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
    usersList.innerHTML = emptyNoUsersHtml();
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

function markMessageFailed(el, content, recipient) {
  el.classList.remove('pending');
  el.classList.add('failed');
  el.dataset.content = content;
  el.dataset.recipient = recipient;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.title = 'Tap to retry';
  const time = el.querySelector('.message-time');
  if (time) time.textContent = 'Failed · tap to retry';
}

function applyGrouping(el, msg) {
  const ts = new Date(msg.timestamp).getTime();
  const grouped = lastRenderedSender === msg.sender
    && lastRenderedDate === dayKey(msg.timestamp)
    && lastRenderedTimestamp
    && ts - lastRenderedTimestamp < GROUP_WINDOW_MS;

  if (grouped) {
    el.classList.add('grouped');
    const messages = messagesContainer.querySelectorAll('.message');
    const previous = messages[messages.length - 2];
    if (previous) {
      previous.classList.remove('group-end');
    }
  }

  el.classList.add('group-end');
  lastRenderedSender = msg.sender;
  lastRenderedTimestamp = ts;
}

function createMessageEl(msg) {
  const messageDiv = document.createElement('div');
  const classes = ['message', msg.sender === username ? 'sent' : 'received'];
  if (msg.pending) classes.push('pending');
  if (msg.failed) classes.push('failed');
  messageDiv.className = classes.join(' ');
  messageDiv.dataset.messageId = msg.id;
  messageDiv.dataset.sender = msg.sender;
  messageDiv.dataset.timestamp = msg.timestamp;
  messageDiv.innerHTML = `
    <div class="message-content">
      <p>${escapeHtml(msg.content)}</p>
      <span class="message-time">${msg.pending ? 'Sending…' : escapeHtml(formatTime(msg.timestamp))}</span>
    </div>
  `;

  if (msg.failed) {
    markMessageFailed(messageDiv, msg.content, msg.recipient);
  }

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
    lastRenderedSender = null;
    lastRenderedTimestamp = null;
    hideJumpLatest();
  }

  if (!messages.length && renderedMessageIds.size === 0) {
    messagesContainer.innerHTML = emptyNoMessagesHtml(currentChatUser || 'them');
    return;
  }

  const empty = messagesContainer.querySelector('.no-messages, .no-chat-selected');
  if (empty && messages.length) {
    empty.remove();
  }

  const nearBottom = isNearBottom();
  let addedIncoming = 0;

  messages.forEach((msg) => {
    if (!msg.id || renderedMessageIds.has(msg.id)) return;
    if (!msg.pending) {
      consumeOptimistic(msg);
    }
    renderedMessageIds.add(msg.id);
    appendDateSeparator(msg.timestamp);
    const el = createMessageEl(msg);
    messagesContainer.appendChild(el);
    applyGrouping(el, msg);
    if (!replace && !msg.pending && msg.sender !== username) {
      addedIncoming += 1;
    }
  });

  if (replace || nearBottom) {
    scrollToLatest();
  } else if (addedIncoming > 0) {
    hiddenIncoming += addedIncoming - 1;
    showJumpLatest();
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
  resizeComposer();
  messageInput.focus();

  document.querySelectorAll('.user-item').forEach((item) => {
    const active = item.dataset.username === user;
    item.classList.toggle('active', active);
    item.classList.toggle('unread', false);
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
  const show = length >= CHAR_COUNT_REVEAL_AT;
  charCount.classList.toggle('hidden', !show);
  charCount.textContent = show ? `${length} / ${MAX_MESSAGE_LENGTH}` : '';
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
  const timeEl = item.querySelector('.user-time');
  previewEl.textContent = `You: ${previewText(content)}`;
  previewEl.classList.remove('hidden');
  if (timeEl) timeEl.textContent = formatListTime(new Date().toISOString());
  usersList.prepend(item);
}

async function sendMessage(content, recipient, { replaceFailedId } = {}) {
  if (!content || !recipient) return;

  if (content.length > MAX_MESSAGE_LENGTH) {
    showToast('Message must be less than 5000 characters', 'error');
    return;
  }

  if (replaceFailedId) {
    const failed = document.querySelector(`[data-message-id="${replaceFailedId}"]`);
    if (failed) {
      renderedMessageIds.delete(replaceFailedId);
      failed.remove();
    }
  }

  const tempId = `temp-${crypto.randomUUID()}`;
  const optimistic = {
    id: tempId,
    sender: username,
    recipient,
    content,
    timestamp: new Date().toISOString(),
    pending: true
  };

  if (recipient === currentChatUser) {
    renderMessages([optimistic]);
  }
  if (recipient === currentChatUser) {
    updateLocalPreview(content);
  }

  try {
    const response = await apiFetch('/messages', {
      method: 'POST',
      body: JSON.stringify({ recipient, content })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to send message');
    }

    if (data.data && recipient === currentChatUser) {
      renderMessages([data.data]);
    }
    loadUsers();
  } catch (error) {
    if (error.message === 'Unauthorized') return;

    const pending = document.querySelector(`[data-message-id="${tempId}"]`);
    if (pending) {
      markMessageFailed(pending, content, recipient);
    }

    console.error('Error sending message:', error);
    showToast(error.message || 'Failed to send message', 'error');
  }
}

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const content = messageInput.value.trim();
  if (!content || !currentChatUser) return;

  messageInput.value = '';
  resizeComposer();
  updateCharCount();
  sendMessage(content, currentChatUser);
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

messageInput.addEventListener('input', () => {
  resizeComposer();
  updateCharCount();
  sendTypingNotice();
});

messagesContainer.addEventListener('click', (event) => {
  const failed = event.target.closest('.message.failed');
  if (!failed) return;
  sendMessage(failed.dataset.content, failed.dataset.recipient, {
    replaceFailedId: failed.dataset.messageId
  });
});

messagesContainer.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const failed = event.target.closest('.message.failed');
  if (!failed) return;
  event.preventDefault();
  sendMessage(failed.dataset.content, failed.dataset.recipient, {
    replaceFailedId: failed.dataset.messageId
  });
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

    notifyIncoming(msg);
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
    setConnectionState('open');
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
    setConnectionState(navigator.onLine ? 'reconnecting' : 'offline');
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

window.addEventListener('offline', () => {
  setConnectionState('offline');
});

window.addEventListener('online', () => {
  if (!socket || socket.readyState !== 1) {
    setConnectionState('reconnecting');
  }
});

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

if (jumpLatest) {
  jumpLatest.addEventListener('click', scrollToLatest);
}

messagesContainer.addEventListener('scroll', () => {
  if (isNearBottom()) {
    hideJumpLatest();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    backgroundUnread = 0;
    updateTitleCount();
  }
});

init();

window.addEventListener('beforeunload', () => {
  clearTimeout(reconnectTimer);
  clearInterval(fallbackPoll);
  if (socket) {
    socket.close();
  }
});
