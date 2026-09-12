const API_URL = '/api';

interface LastMessagePreview {
  content: string;
  timestamp: string;
  sender: string;
}

interface UserSummary {
  username: string;
  unread: number;
  lastMessage: LastMessagePreview | null;
}

interface ChatMessage {
  id: string;
  sender: string;
  recipient: string;
  content: string;
  timestamp: string;
  read?: boolean;
  pending?: boolean;
  failed?: boolean;
}

type ConnectionState = 'open' | 'offline' | 'reconnecting';
type ToastTone = 'info' | 'error';

type SocketPayload =
  | { type: 'message'; message: ChatMessage }
  | { type: 'users_changed' }
  | { type: 'presence'; online: string[] }
  | { type: 'typing'; from: string }
  | { type: 'unread'; unread?: Record<string, number> };

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing #${id}`);
  }
  return el as T;
}

const chatContainer = requireElement<HTMLElement>('chat-container');
const currentUsername = requireElement<HTMLElement>('current-username');
const logoutBtn = requireElement<HTMLButtonElement>('logout-btn');
const usersList = requireElement<HTMLElement>('users-list');
const userSearch = requireElement<HTMLInputElement>('user-search');
const chatWithUser = requireElement<HTMLElement>('chat-with-user');
const backBtn = requireElement<HTMLButtonElement>('back-btn');
const messagesContainer = requireElement<HTMLElement>('messages-container');
const messageForm = requireElement<HTMLFormElement>('message-form');
const messageInput = requireElement<HTMLTextAreaElement>('message-input');
const sendBtn = requireElement<HTMLButtonElement>('send-btn');
const charCount = document.getElementById('char-count');
const typingStatus = requireElement<HTMLElement>('typing-status');
const connectionBanner = document.getElementById('connection-banner');
const toastRegion = document.getElementById('toast-region');
const jumpLatest = document.getElementById('jump-latest');
const composerHint = document.getElementById('composer-hint');

const MAX_MESSAGE_LENGTH = 5000;
const CHAR_COUNT_REVEAL_AT = 4000;
const COMPOSER_MAX_HEIGHT = 120;
const GROUP_WINDOW_MS = 5 * 60 * 1000;
const BASE_TITLE = 'Chat - Chat App';

let currentChatUser: string | null = null;
let username: string | null = localStorage.getItem('username');
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let fallbackPoll: ReturnType<typeof setInterval> | null = null;
let renderedMessageIds = new Set<string>();
let renderedForUser: string | null = null;
let lastRenderedDate: string | null = null;
let lastRenderedSender: string | null = null;
let lastRenderedTimestamp: number | null = null;
let onlineUsers = new Set<string>();
let shuttingDown = false;
let typingThrottle: ReturnType<typeof setTimeout> | null = null;
let hideTypingTimer: ReturnType<typeof setTimeout> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let hiddenIncoming = 0;
let backgroundUnread = 0;
let notificationAsked = false;

function clearSessionStorage(): void {
  localStorage.removeItem('token');
  localStorage.removeItem('username');
}

function showToast(message: string, tone: ToastTone = 'info'): void {
  if (!toastRegion) return;
  toastRegion.textContent = message;
  toastRegion.className = `toast-region toast-visible toast-${tone}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastRegion.classList.remove('toast-visible');
  }, 4000);
}

function setConnectionState(state: ConnectionState): void {
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

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_URL}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers
  });

  if (response.status === 401) {
    handleSessionExpiry();
    throw new Error('Unauthorized');
  }

  return response;
}

function handleSessionExpiry(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  if (socket) {
    socket.close();
    socket = null;
  }
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (fallbackPoll) clearInterval(fallbackPoll);

  clearSessionStorage();
  showToast('Your session expired. Redirecting to login…', 'error');
  setTimeout(() => {
    window.location.href = '/index.html';
  }, 1200);
}

function escapeHtml(text: unknown): string {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatListTime(timestamp?: string): string {
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

function formatDay(timestamp: string): string {
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

function dayKey(timestamp: string): string {
  return new Date(timestamp).toDateString();
}

function previewText(content?: string): string {
  const text = (content || '').replace(/\s+/g, ' ').trim();
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function initialsFor(name?: string): string {
  const clean = (name || '').trim();
  if (!clean) return '?';
  const parts = clean.split(/[_\s]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 52%, 46%)`;
}

function setThreadOpen(open: boolean): void {
  chatContainer.classList.toggle('thread-open', open);
}

function emptyChatSelectedHtml(): string {
  return `
    <div class="empty-state no-chat-selected">
      <p class="empty-title">Pick a conversation</p>
      <p>Choose someone in the list to start chatting. New accounts show up here after they sign up.</p>
    </div>
  `;
}

function emptyNoMessagesHtml(user: string): string {
  return `
    <div class="empty-state no-messages">
      <p class="empty-title">No messages yet</p>
      <p>Say hello to ${escapeHtml(user)}. Enter sends, Shift+Enter starts a new line.</p>
    </div>
  `;
}

function emptyNoUsersHtml(): string {
  return `
    <div class="empty-state no-users">
      <p class="empty-title">You're the only one here</p>
      <p>Open this app in another browser and create a second account, or ask a friend to sign up.</p>
    </div>
  `;
}

function isNearBottom(): boolean {
  return messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 80;
}

function hideJumpLatest(): void {
  hiddenIncoming = 0;
  if (jumpLatest) jumpLatest.classList.add('hidden');
}

function showJumpLatest(): void {
  hiddenIncoming += 1;
  if (!jumpLatest) return;
  jumpLatest.textContent = hiddenIncoming === 1 ? '1 new message' : `${hiddenIncoming} new messages`;
  jumpLatest.classList.remove('hidden');
}

function scrollToLatest(): void {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  hideJumpLatest();
}

function updateTitleCount(): void {
  document.title = document.hidden && backgroundUnread > 0
    ? `(${backgroundUnread}) ${BASE_TITLE}`
    : BASE_TITLE;
}

function notifyIncoming(msg: ChatMessage): void {
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
    void Notification.requestPermission();
  }
}

function resizeComposer(): void {
  messageInput.style.height = 'auto';
  const next = Math.min(messageInput.scrollHeight, COMPOSER_MAX_HEIGHT);
  messageInput.style.height = `${next}px`;
  messageInput.style.overflowY = messageInput.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
}

function closeThread({ fromHistory = false }: { fromHistory?: boolean } = {}): void {
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
  document.querySelectorAll<HTMLElement>('.user-item').forEach((item) => {
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
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (fallbackPoll) clearInterval(fallbackPoll);

  try {
    await apiFetch('/logout', { method: 'POST' });
  } catch (error: unknown) {
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

function applyUserFilter(): void {
  const query = (userSearch.value || '').trim().toLowerCase();
  let visible = 0;

  usersList.querySelectorAll<HTMLElement>('.user-item').forEach((item) => {
    const name = item.dataset.username ?? '';
    const match = !query || name.toLowerCase().includes(query);
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

function syncUserItem(item: HTMLElement, user: UserSummary): void {
  const nameEl = item.querySelector('.user-name');
  const previewEl = item.querySelector('.user-preview');
  const timeEl = item.querySelector('.user-time');
  const badge = item.querySelector('.unread-badge');
  const avatar = item.querySelector<HTMLElement>('.user-avatar');

  if (nameEl) nameEl.textContent = user.username;
  if (avatar) {
    avatar.textContent = initialsFor(user.username);
    avatar.style.background = avatarColor(user.username);
  }
  item.classList.toggle('active', user.username === currentChatUser);
  item.classList.toggle('online', onlineUsers.has(user.username));
  item.setAttribute('aria-pressed', user.username === currentChatUser ? 'true' : 'false');

  if (previewEl) {
    if (user.lastMessage) {
      const prefix = user.lastMessage.sender === username ? 'You: ' : '';
      previewEl.textContent = prefix + previewText(user.lastMessage.content);
      previewEl.classList.remove('hidden');
      if (timeEl) timeEl.textContent = formatListTime(user.lastMessage.timestamp);
    } else {
      previewEl.textContent = 'No messages yet';
      previewEl.classList.remove('hidden');
      if (timeEl) timeEl.textContent = '';
    }
  }

  const count = user.unread || 0;
  const unread = count > 0 && user.username !== currentChatUser;
  item.classList.toggle('unread', unread);
  if (badge) {
    if (unread) {
      badge.textContent = String(count);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

function createUserItem(user: UserSummary): HTMLElement {
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

  const open = (): void => {
    selectUser(user.username);
  };
  userItem.addEventListener('click', open);
  userItem.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });

  return userItem;
}

function renderUsers(users: UserSummary[]): void {
  const existing = new Map<string, HTMLElement>();
  usersList.querySelectorAll<HTMLElement>('.user-item').forEach((item) => {
    if (item.dataset.username) {
      existing.set(item.dataset.username, item);
    }
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

async function loadUsers(): Promise<void> {
  try {
    const response = await apiFetch('/users');
    const data = await response.json() as { users?: UserSummary[]; online?: string[]; error?: string };
    if (!response.ok) {
      console.error('Failed to load users:', data.error);
      return;
    }

    if (Array.isArray(data.online)) {
      onlineUsers = new Set(data.online);
    }
    renderUsers(data.users || []);
  } catch (error: unknown) {
    if (error instanceof Error && error.message !== 'Unauthorized') {
      console.error('Error loading users:', error);
    }
  }
}

function appendDateSeparator(timestamp: string): void {
  const key = dayKey(timestamp);
  if (key === lastRenderedDate) return;
  lastRenderedDate = key;

  const separator = document.createElement('div');
  separator.className = 'date-separator';
  separator.textContent = formatDay(timestamp);
  messagesContainer.appendChild(separator);
}

function markMessageFailed(el: HTMLElement, content: string, recipient: string): void {
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

function applyGrouping(el: HTMLElement, msg: ChatMessage): void {
  const ts = new Date(msg.timestamp).getTime();
  const grouped = lastRenderedSender === msg.sender
    && lastRenderedDate === dayKey(msg.timestamp)
    && lastRenderedTimestamp !== null
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

function createMessageEl(msg: ChatMessage): HTMLElement {
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

function consumeOptimistic(realMsg: ChatMessage): void {
  if (realMsg.sender !== username) return;

  const match = [...messagesContainer.querySelectorAll<HTMLElement>('.message.pending')].find((el) => {
    return el.querySelector('p')?.textContent === realMsg.content;
  });

  if (!match) return;

  if (match.dataset.messageId) {
    renderedMessageIds.delete(match.dataset.messageId);
  }
  match.remove();
}

function renderMessages(messages: ChatMessage[], { replace = false }: { replace?: boolean } = {}): void {
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

async function loadMessages(user: string, { replace = false }: { replace?: boolean } = {}): Promise<void> {
  try {
    const response = await apiFetch(`/messages/${encodeURIComponent(user)}`);
    const data = await response.json() as { messages?: ChatMessage[]; error?: string };
    if (!response.ok) {
      console.error('Failed to load messages:', data.error);
      return;
    }
    renderMessages(data.messages || [], { replace });
  } catch (error: unknown) {
    if (error instanceof Error && error.message !== 'Unauthorized') {
      console.error('Error loading messages:', error);
    }
  }
}

async function markConversationRead(user: string): Promise<void> {
  try {
    await apiFetch(`/messages/${encodeURIComponent(user)}/read`, { method: 'POST' });
  } catch (error: unknown) {
    if (error instanceof Error && error.message !== 'Unauthorized') {
      console.error('Error marking messages read:', error);
    }
  }
}

function selectUser(user: string, { fromHistory = false }: { fromHistory?: boolean } = {}): void {
  currentChatUser = user;
  setThreadOpen(true);
  chatWithUser.textContent = `Chat with ${user}`;
  messageInput.disabled = false;
  sendBtn.disabled = false;
  typingStatus.textContent = '';
  resizeComposer();
  messageInput.focus();

  document.querySelectorAll<HTMLElement>('.user-item').forEach((item) => {
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

  void loadMessages(user, { replace: true });
  void markConversationRead(user);
}

function updateCharCount(): void {
  if (!charCount) return;
  const length = messageInput.value.length;
  const show = length >= CHAR_COUNT_REVEAL_AT;
  charCount.classList.toggle('hidden', !show);
  charCount.textContent = show ? `${length} / ${MAX_MESSAGE_LENGTH}` : '';
  charCount.classList.toggle('over-limit', length > MAX_MESSAGE_LENGTH);
  messageInput.classList.toggle('invalid', length > MAX_MESSAGE_LENGTH);
}

function sendTypingNotice(): void {
  if (!currentChatUser || !socket || socket.readyState !== WebSocket.OPEN) return;
  if (typingThrottle) return;

  socket.send(JSON.stringify({ type: 'typing', to: currentChatUser }));
  typingThrottle = setTimeout(() => {
    typingThrottle = null;
  }, 1500);
}

function showTyping(from: string): void {
  if (from !== currentChatUser) return;
  typingStatus.textContent = `${from} is typing…`;
  if (hideTypingTimer) clearTimeout(hideTypingTimer);
  hideTypingTimer = setTimeout(() => {
    typingStatus.textContent = '';
  }, 2000);
}

function updateLocalPreview(content: string): void {
  const item = document.querySelector<HTMLElement>(`[data-username="${currentChatUser}"]`);
  if (!item) return;
  const previewEl = item.querySelector('.user-preview');
  const timeEl = item.querySelector('.user-time');
  if (previewEl) {
    previewEl.textContent = `You: ${previewText(content)}`;
    previewEl.classList.remove('hidden');
  }
  if (timeEl) timeEl.textContent = formatListTime(new Date().toISOString());
  usersList.prepend(item);
}

async function sendMessage(
  content: string,
  recipient: string,
  { replaceFailedId }: { replaceFailedId?: string } = {}
): Promise<void> {
  if (!content || !recipient || !username) return;

  if (content.length > MAX_MESSAGE_LENGTH) {
    showToast('Message must be less than 5000 characters', 'error');
    return;
  }

  if (replaceFailedId) {
    const failed = document.querySelector<HTMLElement>(`[data-message-id="${replaceFailedId}"]`);
    if (failed) {
      renderedMessageIds.delete(replaceFailedId);
      failed.remove();
    }
  }

  const tempId = `temp-${crypto.randomUUID()}`;
  const optimistic: ChatMessage = {
    id: tempId,
    sender: username,
    recipient,
    content,
    timestamp: new Date().toISOString(),
    pending: true
  };

  if (recipient === currentChatUser) {
    renderMessages([optimistic]);
    updateLocalPreview(content);
  }

  try {
    const response = await apiFetch('/messages', {
      method: 'POST',
      body: JSON.stringify({ recipient, content })
    });
    const data = await response.json() as { data?: ChatMessage; error?: string };

    if (!response.ok) {
      throw new Error(data.error || 'Failed to send message');
    }

    if (data.data && recipient === currentChatUser) {
      renderMessages([data.data]);
    }
    void loadUsers();
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') return;

    const pending = document.querySelector<HTMLElement>(`[data-message-id="${tempId}"]`);
    if (pending) {
      markMessageFailed(pending, content, recipient);
    }

    console.error('Error sending message:', error);
    const message = error instanceof Error ? error.message : 'Failed to send message';
    showToast(message, 'error');
  }
}

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const content = messageInput.value.trim();
  if (!content || !currentChatUser) return;

  messageInput.value = '';
  resizeComposer();
  updateCharCount();
  void sendMessage(content, currentChatUser);
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
  const target = event.target;
  if (!(target instanceof Element)) return;
  const failed = target.closest('.message.failed');
  if (!(failed instanceof HTMLElement)) return;
  const content = failed.dataset.content;
  const recipient = failed.dataset.recipient;
  if (!content || !recipient) return;
  void sendMessage(content, recipient, {
    replaceFailedId: failed.dataset.messageId
  });
});

messagesContainer.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const failed = target.closest('.message.failed');
  if (!(failed instanceof HTMLElement)) return;
  event.preventDefault();
  const content = failed.dataset.content;
  const recipient = failed.dataset.recipient;
  if (!content || !recipient) return;
  void sendMessage(content, recipient, {
    replaceFailedId: failed.dataset.messageId
  });
});

function handleSocketMessage(payload: SocketPayload): void {
  if (payload.type === 'message' && payload.message) {
    const msg = payload.message;
    const otherUser = msg.sender === username ? msg.recipient : msg.sender;

    if (currentChatUser === otherUser) {
      renderMessages([msg]);
      if (msg.recipient === username) {
        void markConversationRead(otherUser);
      }
    }

    notifyIncoming(msg);
    void loadUsers();
    return;
  }

  if (payload.type === 'users_changed') {
    void loadUsers();
    return;
  }

  if (payload.type === 'presence' && Array.isArray(payload.online)) {
    onlineUsers = new Set(payload.online);
    document.querySelectorAll<HTMLElement>('.user-item').forEach((item) => {
      item.classList.toggle('online', onlineUsers.has(item.dataset.username ?? ''));
    });
    return;
  }

  if (payload.type === 'typing' && payload.from) {
    showTyping(payload.from);
    return;
  }

  if (payload.type === 'unread') {
    void loadUsers();
  }
}

function connectSocket(): void {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  socket.addEventListener('open', () => {
    setConnectionState('open');
    if (fallbackPoll) clearInterval(fallbackPoll);
    fallbackPoll = null;
  });

  socket.addEventListener('message', (event) => {
    try {
      handleSocketMessage(JSON.parse(String(event.data)) as SocketPayload);
    } catch (error: unknown) {
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
        void loadUsers();
        if (currentChatUser) {
          void loadMessages(currentChatUser);
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
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setConnectionState('reconnecting');
  }
});

async function init(): Promise<void> {
  try {
    const response = await apiFetch('/me');
    const data = await response.json() as { username?: string };
    if (!response.ok || !data.username) {
      handleSessionExpiry();
      return;
    }

    username = data.username;
    localStorage.setItem('username', username);
    localStorage.removeItem('token');
    currentUsername.textContent = username;
  } catch (error: unknown) {
    if (!(error instanceof Error) || error.message !== 'Unauthorized') {
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

export {};

void init();

window.addEventListener('beforeunload', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (fallbackPoll) clearInterval(fallbackPoll);
  if (socket) {
    socket.close();
  }
});
