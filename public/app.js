const socket = io({
  reconnectionAttempts: Infinity,
  reconnectionDelayMax: 4000,
});

const MAX_FILES = 10;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const LAST_ROOM_KEY = "local-chat-last-room";
const NICKNAME_KEY = "local-chat-nickname";
let activeUploadRequest = null;
let suppressUploadError = false;

const state = {
  meIp: "",
  nickname: "",
  room: null,
  messages: [],
  users: [],
  files: [],
  searchTerm: "",
  typingUsers: [],
  pendingJoinCode: "",
  isJoining: false,
  isUploading: false,
  isSending: false,
  isDestroying: false,
};

const els = {
  sidebar: document.querySelector("#sidebar"),
  mainArea: document.querySelector("#mainArea"),
  connectionStatus: document.querySelector("#connectionStatus"),
  myIpLabel: document.querySelector("#myIpLabel"),
  nicknameInput: document.querySelector("#nicknameInput"),
  lobbySidebar: document.querySelector("#lobbySidebar"),
  roomSidebar: document.querySelector("#roomSidebar"),
  lobbyView: document.querySelector("#lobbyView"),
  chatView: document.querySelector("#chatView"),
  createRoomButton: document.querySelector("#createRoomButton"),
  joinForm: document.querySelector("#joinForm"),
  joinRoomButton: document.querySelector("#joinRoomButton"),
  roomCodeInput: document.querySelector("#roomCodeInput"),
  recentRoom: document.querySelector("#recentRoom"),
  roomCodeLabel: document.querySelector("#roomCodeLabel"),
  roomCodeMirror: document.querySelector("#roomCodeMirror"),
  ownerLabel: document.querySelector("#ownerLabel"),
  messageCount: document.querySelector("#messageCount"),
  summaryFileCount: document.querySelector("#summaryFileCount"),
  summaryUserCount: document.querySelector("#summaryUserCount"),
  copyCodeButton: document.querySelector("#copyCodeButton"),
  userCount: document.querySelector("#userCount"),
  userList: document.querySelector("#userList"),
  searchHistory: document.querySelector("#searchHistory"),
  clearSearchHistoryButton: document.querySelector("#clearSearchHistoryButton"),
  fileCount: document.querySelector("#fileCount"),
  fileList: document.querySelector("#fileList"),
  dropZone: document.querySelector("#dropZone"),
  fileInput: document.querySelector("#fileInput"),
  pickFileButton: document.querySelector("#pickFileButton"),
  uploadProgress: document.querySelector("#uploadProgress"),
  destroyRoomButton: document.querySelector("#destroyRoomButton"),
  leaveRoomButton: document.querySelector("#leaveRoomButton"),
  searchInput: document.querySelector("#searchInput"),
  clearSearchButton: document.querySelector("#clearSearchButton"),
  messages: document.querySelector("#messages"),
  typingLine: document.querySelector("#typingLine"),
  messageForm: document.querySelector("#messageForm"),
  messageInput: document.querySelector("#messageInput"),
  messageSendButton: document.querySelector("#messageSendButton"),
  toastStack: document.querySelector("#toastStack"),
};

function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  els.toastStack.append(node);
  setTimeout(() => node.remove(), 3600);
}

function setConnectionStatus(message, status) {
  els.connectionStatus.textContent = message;
  els.connectionStatus.dataset.status = status;
}

function getRoomCodeFromUrl() {
  try {
    return new URL(window.location.href).searchParams.get("room")?.replace(/\D/g, "").slice(0, 4) || "";
  } catch {
    return "";
  }
}

function extractRoomCode(value) {
  const rawValue = String(value || "").trim();
  try {
    const code = new URL(rawValue, window.location.origin).searchParams.get("room");
    if (/^\d{4}$/.test(code)) {
      return code;
    }
  } catch {
    // Fall back to plain numeric input handling below.
  }

  try {
    const code = new URLSearchParams(rawValue).get("room");
    if (/^\d{4}$/.test(code)) {
      return code;
    }
  } catch {
    // Fall back to plain numeric input handling below.
  }

  return rawValue.replace(/\D/g, "").slice(0, 4);
}

function getInviteUrl(code) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", code);
  url.hash = "";
  return url.toString();
}

function setRoomUrl(code) {
  const url = getInviteUrl(code);
  window.history.replaceState(null, "", url);
}

function clearRoomUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  window.history.replaceState(null, "", url.toString());
}

function updateControls() {
  const connected = socket.connected;
  const inRoom = Boolean(state.room);
  const busyJoining = state.isJoining;

  els.createRoomButton.disabled = busyJoining || !connected;
  if (els.joinRoomButton) {
    els.joinRoomButton.disabled = busyJoining || !connected;
  }
  els.roomCodeInput.disabled = busyJoining;

  const canTalk = inRoom && connected && !state.isSending;
  els.messageInput.disabled = !canTalk;
  els.messageInput.placeholder = connected
    ? "메시지 입력"
    : "연결 복구 중";
  if (els.messageSendButton) {
    els.messageSendButton.disabled = !canTalk;
    els.messageSendButton.textContent = state.isSending ? "전송 중" : "전송";
  }

  els.pickFileButton.disabled = !inRoom || state.isUploading;
  els.leaveRoomButton.disabled = busyJoining;
  els.copyCodeButton.disabled = !inRoom;
  els.destroyRoomButton.disabled = !inRoom || busyJoining || state.isDestroying;
  els.destroyRoomButton.textContent = state.isDestroying ? "삭제 중" : "방 삭제";

  if (busyJoining) {
    els.createRoomButton.textContent = "입장 중";
    if (els.joinRoomButton) {
      els.joinRoomButton.textContent = "확인 중";
    }
    return;
  }

  els.createRoomButton.textContent = "새 방 생성";
  if (els.joinRoomButton) {
    els.joinRoomButton.textContent = "입장";
  }
}

function finishJoinAttempt() {
  state.isJoining = false;
  state.pendingJoinCode = "";
  renderRecentRoom();
  updateControls();
}

function prepareInitialRoomFromUrl() {
  const roomCode = getRoomCodeFromUrl();
  if (roomCode.length !== 4) {
    return;
  }
  els.roomCodeInput.value = roomCode;
  state.pendingJoinCode = roomCode;
  state.isJoining = true;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function roomSearchKey() {
  return state.room ? `local-chat-search:${state.room.code}` : "local-chat-search";
}

function getStoredItem(key, fallback = "") {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function setStoredItem(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Search history and recent rooms are convenience features.
  }
}

function removeStoredItem(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Search history and recent rooms are convenience features.
  }
}

function sanitizeNickname(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

function nicknameFallback() {
  const ipTail = state.meIp.split(".").filter(Boolean).pop();
  return ipTail ? `사용자-${ipTail}` : "사용자";
}

function getNickname() {
  const current = sanitizeNickname(els.nicknameInput.value);
  return current || nicknameFallback();
}

function setNickname(value, { persist = true, notify = true } = {}) {
  const nickname = sanitizeNickname(value) || nicknameFallback();
  state.nickname = nickname;
  els.nicknameInput.value = nickname;
  if (persist) {
    setStoredItem(NICKNAME_KEY, nickname);
  }
  if (notify && socket.connected) {
    socket.emit("updateNickname", { nickname });
  }
  return nickname;
}

function getDisplayName(entity = {}) {
  return (
    sanitizeNickname(entity.senderName || entity.nickname || entity.name) ||
    entity.senderIp ||
    entity.ip ||
    "알 수 없음"
  );
}

function getUserByIp(ip) {
  return state.users.find((user) => user.ip === ip) || null;
}

function getInitials(name) {
  const cleaned = sanitizeNickname(name);
  if (!cleaned) {
    return "?";
  }
  const ascii = cleaned.match(/[A-Za-z0-9]/g);
  if (ascii && ascii.length > 0) {
    return ascii.slice(0, 2).join("").toUpperCase();
  }
  return cleaned.slice(0, 2);
}

function getSearchHistory() {
  try {
    return JSON.parse(getStoredItem(roomSearchKey(), "[]"));
  } catch {
    return [];
  }
}

function saveSearchTerm(term) {
  const cleaned = term.trim();
  if (!cleaned) {
    return;
  }
  const next = [cleaned, ...getSearchHistory().filter((item) => item !== cleaned)].slice(0, 8);
  setStoredItem(roomSearchKey(), JSON.stringify(next));
  renderSearchHistory();
}

function clearSearchHistory() {
  removeStoredItem(roomSearchKey());
  renderSearchHistory();
}

function getLastRoomCode() {
  return getStoredItem(LAST_ROOM_KEY);
}

function saveLastRoomCode(code) {
  setStoredItem(LAST_ROOM_KEY, code);
}

function renderRecentRoom() {
  const code = getLastRoomCode();
  els.recentRoom.replaceChildren();
  const shouldHide = !code || Boolean(state.room) || Boolean(state.pendingJoinCode);
  els.recentRoom.classList.toggle("hidden", shouldHide);
  if (shouldHide) {
    return;
  }

  const label = document.createElement("span");
  label.textContent = "최근 방";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = code;
  button.addEventListener("click", () => {
    els.roomCodeInput.value = code;
    joinRoom(code);
  });
  els.recentRoom.append(label, button);
}

function mergeFiles(files) {
  const byId = new Map(state.files.map((file) => [file.id, file]));
  for (const file of files) {
    byId.set(file.id, file);
  }
  state.files = [...byId.values()];
  els.fileCount.textContent = String(state.files.length);
  els.summaryFileCount.textContent = String(state.files.length);
  renderFiles();
}

function setUploadProgress(percent) {
  const active = percent > 0;
  const value = active ? Math.max(1, Math.min(99, Math.round(percent))) : 0;
  els.uploadProgress.classList.toggle("hidden", !active);
  els.uploadProgress.setAttribute("aria-valuenow", String(value));
  els.uploadProgress.querySelector("span").style.width = `${value}%`;
}

function abortActiveUpload() {
  if (!activeUploadRequest) {
    return;
  }
  suppressUploadError = true;
  activeUploadRequest.abort();
}

function postFiles(roomCode, body, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    activeUploadRequest = request;
    request.open("POST", `/api/rooms/${roomCode}/files`);
    request.responseType = "json";

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress((event.loaded / event.total) * 100);
      }
    });

    request.addEventListener("load", () => {
      const data =
        request.response && typeof request.response === "object"
          ? request.response
          : {};
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(data.error || "업로드 실패"));
        return;
      }
      resolve(data);
    });

    const clearActiveRequest = () => {
      if (activeUploadRequest === request) {
        activeUploadRequest = null;
      }
    };

    request.addEventListener("loadend", clearActiveRequest);
    request.addEventListener("error", () => reject(new Error("업로드 연결이 끊겼습니다.")));
    request.addEventListener("abort", () => reject(new Error("업로드가 취소되었습니다.")));
    request.send(body);
  });
}

function setSearchTerm(term, persist = false) {
  state.searchTerm = term.trim();
  els.searchInput.value = state.searchTerm;
  if (persist) {
    saveSearchTerm(state.searchTerm);
  }
  renderMessages();
}

function appendHighlightedText(parent, text, query) {
  if (!query) {
    parent.textContent = text;
    return;
  }
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let cursor = 0;
  let matchIndex = lowerText.indexOf(lowerQuery);
  while (matchIndex !== -1) {
    parent.append(document.createTextNode(text.slice(cursor, matchIndex)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(matchIndex, matchIndex + query.length);
    parent.append(mark);
    cursor = matchIndex + query.length;
    matchIndex = lowerText.indexOf(lowerQuery, cursor);
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}

function messageMatches(message) {
  if (!state.searchTerm) {
    return true;
  }
  const haystack = [message.text, message.senderName, message.senderIp, message.file?.name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(state.searchTerm.toLowerCase());
}

function renderMessages() {
  const wasNearBottom =
    els.messages.scrollTop + els.messages.clientHeight >= els.messages.scrollHeight - 80;
  els.messages.replaceChildren();

  const visible = state.messages.filter(messageMatches);
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.searchTerm ? "검색 결과가 없습니다." : "아직 메시지가 없습니다.";
    els.messages.append(empty);
    return;
  }

  for (const message of visible) {
    const node = document.createElement("article");
    node.className = "message";
    if (message.type === "system") {
      node.classList.add("system");
      const text = document.createElement("div");
      text.className = "message-text";
      appendHighlightedText(text, message.text, state.searchTerm);
      node.append(text);
      els.messages.append(node);
      continue;
    }

    if (message.senderIp === state.meIp) {
      node.classList.add("own");
    }

    const meta = document.createElement("div");
    meta.className = "message-meta";
    const sender = document.createElement("strong");
    const senderName = getDisplayName(message);
    sender.textContent = message.senderIp === state.meIp ? `${senderName} (나)` : senderName;
    sender.title = message.senderIp || "";
    const time = document.createElement("span");
    time.textContent = formatTime(message.createdAt);
    meta.append(sender, time);

    const text = document.createElement("div");
    text.className = "message-text";
    appendHighlightedText(text, message.text || "", state.searchTerm);
    node.append(meta, text);

    if (message.type === "file" && message.file) {
      const file = document.createElement("div");
      file.className = "file-message";
      const link = document.createElement("a");
      link.href = message.file.downloadUrl;
      link.textContent = message.file.name;
      const fileMeta = document.createElement("div");
      fileMeta.className = "file-meta";
      fileMeta.textContent = `${formatBytes(message.file.size)} · ${formatDateTime(
        message.file.expiresAt
      )} 만료`;
      file.append(link, fileMeta);
      node.append(file);
    }

    els.messages.append(node);
  }

  if (wasNearBottom) {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
}

function renderUsers() {
  els.userCount.textContent = String(state.users.length);
  els.summaryUserCount.textContent = String(state.users.length);
  els.userList.replaceChildren();
  for (const user of state.users) {
    const item = document.createElement("li");
    item.classList.toggle("is-me", user.ip === state.meIp);

    const main = document.createElement("div");
    main.className = "user-main";
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = getInitials(user.nickname || user.ip);

    const text = document.createElement("div");
    text.className = "user-text";
    const name = document.createElement("span");
    name.className = "user-name";
    name.textContent =
      user.ip === state.meIp ? `${getDisplayName(user)} (나)` : getDisplayName(user);
    const ip = document.createElement("span");
    ip.className = "user-ip";
    ip.textContent = user.ip;
    text.append(name, ip);
    main.append(avatar, text);
    item.append(main);

    if (user.isOwner) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "방장";
      item.append(badge);
    }
    els.userList.append(item);
  }
}

function renderFiles() {
  els.fileList.replaceChildren();
  if (state.files.length === 0) {
    const empty = document.createElement("span");
    empty.className = "meta-line";
    empty.textContent = "업로드된 파일 없음";
    els.fileList.append(empty);
    return;
  }

  for (const file of state.files) {
    const item = document.createElement("a");
    item.className = "file-list-item";
    item.href = file.downloadUrl;
    const name = document.createElement("strong");
    name.textContent = file.name;
    const meta = document.createElement("span");
    const uploader = sanitizeNickname(file.uploadedByName) || file.uploadedByIp || "알 수 없음";
    meta.textContent = `${uploader} · ${formatBytes(file.size)} · ${formatDateTime(
      file.expiresAt
    )} 만료`;
    item.append(name, meta);
    els.fileList.append(item);
  }
}

function renderSearchHistory() {
  els.searchHistory.replaceChildren();
  const history = getSearchHistory();
  if (history.length === 0) {
    const empty = document.createElement("span");
    empty.className = "meta-line";
    empty.textContent = "검색어 없음";
    els.searchHistory.append(empty);
    return;
  }
  for (const term of history) {
    const button = document.createElement("button");
    button.className = "history-chip";
    button.type = "button";
    button.textContent = term;
    button.addEventListener("click", () => setSearchTerm(term));
    els.searchHistory.append(button);
  }
}

function renderOwnerLabel() {
  if (!state.room) {
    return;
  }
  const owner = state.users.find((user) => user.isOwner);
  const ownerName = owner ? getDisplayName(owner) : state.room.ownerName || state.room.ownerIp;
  els.ownerLabel.textContent =
    state.room.ownerIp === state.meIp
      ? `방장: ${ownerName} (나)`
      : `방장: ${ownerName}`;
}

function renderRoom() {
  if (!state.room) {
    return;
  }
  els.roomCodeLabel.textContent = state.room.code;
  if (els.roomCodeMirror) {
    els.roomCodeMirror.textContent = `#${state.room.code}`;
  }
  renderOwnerLabel();
  els.fileCount.textContent = String(state.files.length);
  els.summaryFileCount.textContent = String(state.files.length);
  els.summaryUserCount.textContent = String(state.users.length);
  els.messageCount.textContent = String(state.messages.length);
  els.destroyRoomButton.classList.toggle("hidden", !state.room.isOwner);
  renderUsers();
  renderFiles();
  renderSearchHistory();
  renderMessages();
}

function enterRoom(payload) {
  state.room = payload.room;
  state.meIp = payload.me.ip;
  setNickname(payload.me.nickname || getNickname(), { persist: true, notify: false });
  state.messages = payload.messages || [];
  state.users = payload.users || [];
  state.files = payload.files || [];
  state.typingUsers = [];
  state.searchTerm = "";
  els.searchInput.value = "";
  document.body.classList.add("in-room");
  els.lobbySidebar.classList.add("hidden");
  els.roomSidebar.classList.remove("hidden");
  els.lobbyView.classList.add("hidden");
  els.chatView.classList.remove("hidden");
  saveLastRoomCode(state.room.code);
  setRoomUrl(state.room.code);
  finishJoinAttempt();
  renderRoom();
  els.messageInput.focus();
}

function leaveRoom({ notifyServer = true } = {}) {
  if (notifyServer && state.room && socket.connected) {
    socket.emit("leaveRoom");
  }
  state.room = null;
  state.messages = [];
  state.users = [];
  state.files = [];
  state.typingUsers = [];
  state.searchTerm = "";
  state.pendingJoinCode = "";
  state.isJoining = false;
  state.isSending = false;
  state.isUploading = false;
  state.isDestroying = false;
  abortActiveUpload();
  setUploadProgress(0);
  document.body.classList.remove("in-room");
  els.roomSidebar.classList.add("hidden");
  els.lobbySidebar.classList.remove("hidden");
  els.chatView.classList.add("hidden");
  els.lobbyView.classList.remove("hidden");
  if (els.roomCodeMirror) {
    els.roomCodeMirror.textContent = "----";
  }
  clearRoomUrl();
  renderRecentRoom();
  updateControls();
  els.roomCodeInput.focus();
}

async function createRoom() {
  if (!socket.connected) {
    toast("실시간 연결이 복구된 뒤 방을 만들 수 있습니다.");
    return;
  }
  state.isJoining = true;
  updateControls();
  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: getNickname() }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "방 생성 실패");
    }
    joinRoom(data.room.code);
  } catch (error) {
    finishJoinAttempt();
    toast(error.message);
  }
}

function joinRoom(code) {
  const roomCode = extractRoomCode(code);
  if (roomCode.length !== 4) {
    toast("4자리 참여 코드를 입력해주세요.");
    return;
  }
  state.pendingJoinCode = roomCode;
  state.isJoining = true;
  updateControls();

  if (!socket.connected) {
    toast("실시간 연결 후 자동으로 입장합니다.");
    return;
  }

  sendJoinRequest(roomCode);
}

function sendJoinRequest(roomCode, { quiet = false } = {}) {
  if (!quiet) {
    state.pendingJoinCode = roomCode;
    state.isJoining = true;
    updateControls();
  }

  socket
    .timeout(5000)
    .emit("joinRoom", { roomCode, nickname: getNickname() }, (error, response = {}) => {
      if (error) {
        if (!quiet) {
          state.isJoining = false;
          updateControls();
        }
        toast("방 입장 응답이 지연됩니다. 연결 상태를 확인해주세요.");
        return;
      }

      if (!response.ok) {
        if (getRoomCodeFromUrl() === roomCode) {
          clearRoomUrl();
        }
        if (!quiet) {
          finishJoinAttempt();
        } else if (state.room?.code === roomCode) {
          leaveRoom({ notifyServer: false });
        }
        toast(response.error || "방에 입장할 수 없습니다.");
      }
    });
}

async function uploadFiles(fileList) {
  if (!state.room) {
    toast("먼저 방에 입장해주세요.");
    return;
  }

  const files = [...fileList];
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length === 0) {
    return;
  }
  if (files.length > MAX_FILES || totalSize > MAX_UPLOAD_BYTES) {
    toast("한 번에 최대 10개, 총 100MB까지 업로드할 수 있습니다.");
    return;
  }

  const body = new FormData();
  body.append("nickname", getNickname());
  for (const file of files) {
    body.append("files", file);
  }

  const uploadRoomCode = state.room.code;
  state.isUploading = true;
  updateControls();
  setUploadProgress(1);
  els.pickFileButton.textContent = "업로드 중";
  try {
    const data = await postFiles(uploadRoomCode, body, setUploadProgress);
    if (!state.room || state.room.code !== uploadRoomCode) {
      return;
    }
    mergeFiles(data.files || []);
    toast(`${data.files.length}개 파일 업로드 완료`);
  } catch (error) {
    if (!suppressUploadError) {
      toast(error.message);
    }
  } finally {
    els.fileInput.value = "";
    state.isUploading = false;
    setUploadProgress(0);
    suppressUploadError = false;
    updateControls();
    els.pickFileButton.textContent = "파일 선택";
  }
}

function renderTypingLine() {
  const users = state.typingUsers
    .filter((ip) => ip !== state.meIp)
    .map((ip) => getUserByIp(ip))
    .filter(Boolean);
  els.typingLine.replaceChildren();
  if (users.length === 0) {
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "typing-bubble";
  const label = document.createElement("span");
  label.textContent = `${users.slice(0, 2).map(getDisplayName).join(", ")} 입력 중`;
  const dots = document.createElement("span");
  dots.className = "typing-dots";
  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement("span");
    dot.className = "typing-dot";
    dots.append(dot);
  }
  wrapper.append(label, dots);
  els.typingLine.append(wrapper);
}

let typingTimer = null;
function signalTyping() {
  if (!state.room || !socket.connected) {
    return;
  }
  socket.emit("typing", { isTyping: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit("typing", { isTyping: false }), 1200);
}

async function loadMe() {
  try {
    const response = await fetch("/api/me");
    const data = await response.json();
    state.meIp = data.ip;
    els.myIpLabel.textContent = data.ip;
    const storedNickname = getStoredItem(NICKNAME_KEY);
    setNickname(storedNickname || nicknameFallback(), { persist: !storedNickname, notify: false });
  } catch {
    els.myIpLabel.textContent = "IP 확인 실패";
    setNickname(getStoredItem(NICKNAME_KEY) || "사용자", { persist: false, notify: false });
  }
}

socket.on("connect", () => {
  setConnectionStatus("실시간 연결됨", "online");
  updateControls();

  if (state.pendingJoinCode) {
    sendJoinRequest(state.pendingJoinCode);
    return;
  }

  if (state.room) {
    sendJoinRequest(state.room.code, { quiet: true });
  }
});

socket.on("disconnect", () => {
  setConnectionStatus("재연결 중", "offline");
  updateControls();
});

socket.io.on("reconnect_attempt", () => {
  setConnectionStatus("재연결 중", "offline");
  updateControls();
});

socket.on("connect_error", () => {
  setConnectionStatus("연결 실패", "offline");
  updateControls();
});

socket.on("errorMessage", (message) => {
  if (state.isJoining) {
    finishJoinAttempt();
  }
  toast(message);
});

socket.on("roomJoined", enterRoom);

socket.on("messageCreated", (message) => {
  if (!state.room || message.roomCode !== state.room.code) {
    return;
  }
  if (state.messages.some((item) => item.id === message.id)) {
    return;
  }
  state.messages.push(message);
  els.messageCount.textContent = String(state.messages.length);
  if (message.type === "file" && message.file) {
    mergeFiles([message.file]);
  }
  renderMessages();
});

socket.on("presenceChanged", ({ roomCode, users }) => {
  if (!state.room || roomCode !== state.room.code) {
    return;
  }
  state.users = users || [];
  renderUsers();
  renderOwnerLabel();
  renderTypingLine();
});

socket.on("typingChanged", ({ roomCode, users }) => {
  if (!state.room || roomCode !== state.room.code) {
    return;
  }
  state.typingUsers = users || [];
  renderTypingLine();
});

socket.on("fileExpired", ({ roomCode, fileId }) => {
  if (!state.room || roomCode !== state.room.code) {
    return;
  }
  state.files = state.files.filter((file) => file.id !== fileId);
  els.fileCount.textContent = String(state.files.length);
  els.summaryFileCount.textContent = String(state.files.length);
  renderFiles();
});

socket.on("roomDestroyed", ({ roomCode, destroyedByIp }) => {
  if (!state.room || roomCode !== state.room.code) {
    return;
  }
  const ownAction = destroyedByIp === state.meIp;
  leaveRoom({ notifyServer: false });
  toast(ownAction ? "방을 삭제했습니다." : "방장이 방을 삭제했습니다.");
});

els.createRoomButton.addEventListener("click", createRoom);

els.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  joinRoom(els.roomCodeInput.value);
});

els.roomCodeInput.addEventListener("input", () => {
  els.roomCodeInput.value = els.roomCodeInput.value.replace(/\D/g, "").slice(0, 4);
});

els.roomCodeInput.addEventListener("paste", (event) => {
  const pastedText = event.clipboardData?.getData("text") || "";
  const roomCode = extractRoomCode(pastedText);
  if (roomCode.length !== 4) {
    return;
  }
  event.preventDefault();
  els.roomCodeInput.value = roomCode;
});

els.nicknameInput.addEventListener("input", () => {
  const nickname = sanitizeNickname(els.nicknameInput.value);
  state.nickname = nickname;
  if (nickname) {
    setStoredItem(NICKNAME_KEY, nickname);
  }
});

els.nicknameInput.addEventListener("change", () => {
  setNickname(els.nicknameInput.value);
});

els.nicknameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    setNickname(els.nicknameInput.value);
    els.nicknameInput.blur();
  }
});

els.copyCodeButton.addEventListener("click", async () => {
  if (!state.room) {
    return;
  }
  const inviteUrl = getInviteUrl(state.room.code);
  try {
    await navigator.clipboard.writeText(inviteUrl);
    toast("초대 링크를 복사했습니다.");
  } catch {
    const helper = document.createElement("input");
    helper.value = inviteUrl;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
    toast("초대 링크를 복사했습니다.");
  }
});

els.leaveRoomButton.addEventListener("click", () => leaveRoom());

els.destroyRoomButton.addEventListener("click", () => {
  if (!state.room || !state.room.isOwner) {
    return;
  }
  const ok = window.confirm("방을 삭제하면 메시지와 업로드 파일이 모두 삭제됩니다.");
  if (ok) {
    state.isDestroying = true;
    updateControls();
    socket.timeout(5000).emit("destroyRoom", (error, response = {}) => {
      if (!state.room) {
        return;
      }
      state.isDestroying = false;
      updateControls();
      if (error) {
        toast("방 삭제 응답이 지연됩니다. 연결 상태를 확인해주세요.");
        return;
      }
      if (!response.ok) {
        toast(response.error || "방을 삭제할 수 없습니다.");
      }
    });
  }
});

els.searchInput.addEventListener("input", () => {
  state.searchTerm = els.searchInput.value.trim();
  renderMessages();
});

els.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    saveSearchTerm(els.searchInput.value);
  }
});

els.clearSearchButton.addEventListener("click", () => setSearchTerm(""));
els.clearSearchHistoryButton.addEventListener("click", clearSearchHistory);

els.pickFileButton.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => uploadFiles(els.fileInput.files));

for (const eventName of ["dragenter", "dragover"]) {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.add("dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("dragging");
  });
}

els.dropZone.addEventListener("drop", (event) => {
  uploadFiles(event.dataTransfer.files);
});

els.messageInput.addEventListener("input", () => {
  signalTyping();
  els.messageInput.style.height = "auto";
  els.messageInput.style.height = `${Math.min(132, els.messageInput.scrollHeight)}px`;
});

els.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.messageForm.requestSubmit();
  }
});

els.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.room) {
    return;
  }
  if (!socket.connected) {
    toast("연결이 복구된 뒤 메시지를 보낼 수 있습니다.");
    return;
  }
  const text = els.messageInput.value.trim();
  if (!text) {
    return;
  }
  const sendRoomCode = state.room.code;
  state.isSending = true;
  updateControls();
  socket
    .timeout(5000)
    .emit("sendMessage", { text, nickname: getNickname() }, (error, response = {}) => {
      state.isSending = false;
      updateControls();
      if (!state.room || state.room.code !== sendRoomCode) {
        return;
      }

      if (error) {
        toast("메시지 전송 응답이 지연됩니다. 다시 시도해주세요.");
        els.messageInput.focus();
        return;
      }

      if (!response.ok) {
        toast(response.error || "메시지를 보낼 수 없습니다.");
        els.messageInput.focus();
        return;
      }

      socket.emit("typing", { isTyping: false });
      els.messageInput.value = "";
      els.messageInput.style.height = "auto";
      els.messageInput.focus();
    });
});

setConnectionStatus("연결 준비 중", "pending");
setNickname(getStoredItem(NICKNAME_KEY) || "사용자", { persist: false, notify: false });
prepareInitialRoomFromUrl();
renderRecentRoom();
updateControls();
loadMe();
