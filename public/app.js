const socket = io();

const MAX_FILES = 10;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const state = {
  meIp: "",
  room: null,
  messages: [],
  users: [],
  files: [],
  searchTerm: "",
  typingUsers: [],
};

const els = {
  connectionStatus: document.querySelector("#connectionStatus"),
  myIpLabel: document.querySelector("#myIpLabel"),
  lobbyView: document.querySelector("#lobbyView"),
  chatView: document.querySelector("#chatView"),
  createRoomButton: document.querySelector("#createRoomButton"),
  joinForm: document.querySelector("#joinForm"),
  roomCodeInput: document.querySelector("#roomCodeInput"),
  roomCodeLabel: document.querySelector("#roomCodeLabel"),
  ownerLabel: document.querySelector("#ownerLabel"),
  copyCodeButton: document.querySelector("#copyCodeButton"),
  userCount: document.querySelector("#userCount"),
  userList: document.querySelector("#userList"),
  searchHistory: document.querySelector("#searchHistory"),
  clearSearchHistoryButton: document.querySelector("#clearSearchHistoryButton"),
  fileCount: document.querySelector("#fileCount"),
  dropZone: document.querySelector("#dropZone"),
  fileInput: document.querySelector("#fileInput"),
  pickFileButton: document.querySelector("#pickFileButton"),
  destroyRoomButton: document.querySelector("#destroyRoomButton"),
  leaveRoomButton: document.querySelector("#leaveRoomButton"),
  searchInput: document.querySelector("#searchInput"),
  clearSearchButton: document.querySelector("#clearSearchButton"),
  messages: document.querySelector("#messages"),
  typingLine: document.querySelector("#typingLine"),
  messageForm: document.querySelector("#messageForm"),
  messageInput: document.querySelector("#messageInput"),
  toastStack: document.querySelector("#toastStack"),
};

function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  els.toastStack.append(node);
  setTimeout(() => node.remove(), 3600);
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

function getSearchHistory() {
  try {
    return JSON.parse(localStorage.getItem(roomSearchKey()) || "[]");
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
  localStorage.setItem(roomSearchKey(), JSON.stringify(next));
  renderSearchHistory();
}

function clearSearchHistory() {
  localStorage.removeItem(roomSearchKey());
  renderSearchHistory();
}

function mergeFiles(files) {
  const byId = new Map(state.files.map((file) => [file.id, file]));
  for (const file of files) {
    byId.set(file.id, file);
  }
  state.files = [...byId.values()];
  els.fileCount.textContent = String(state.files.length);
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
  const haystack = [message.text, message.senderIp, message.file?.name]
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
    sender.textContent =
      message.senderIp === state.meIp ? `${message.senderIp} (나)` : message.senderIp;
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
  els.userList.replaceChildren();
  for (const user of state.users) {
    const item = document.createElement("li");
    const ip = document.createElement("span");
    ip.className = "user-ip";
    ip.textContent = user.ip === state.meIp ? `${user.ip} (나)` : user.ip;
    item.append(ip);
    if (user.isOwner) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "방장";
      item.append(badge);
    }
    els.userList.append(item);
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

function renderRoom() {
  if (!state.room) {
    return;
  }
  els.roomCodeLabel.textContent = state.room.code;
  els.ownerLabel.textContent =
    state.room.ownerIp === state.meIp
      ? `방장: ${state.room.ownerIp} (나)`
      : `방장: ${state.room.ownerIp}`;
  els.fileCount.textContent = String(state.files.length);
  els.destroyRoomButton.classList.toggle("hidden", !state.room.isOwner);
  renderUsers();
  renderSearchHistory();
  renderMessages();
}

function enterRoom(payload) {
  state.room = payload.room;
  state.meIp = payload.me.ip;
  state.messages = payload.messages || [];
  state.users = payload.users || [];
  state.files = payload.files || [];
  state.typingUsers = [];
  state.searchTerm = "";
  els.searchInput.value = "";
  els.lobbyView.classList.add("hidden");
  els.chatView.classList.remove("hidden");
  renderRoom();
  els.messageInput.focus();
}

function leaveRoom({ notifyServer = true } = {}) {
  if (notifyServer && state.room) {
    socket.emit("leaveRoom");
  }
  state.room = null;
  state.messages = [];
  state.users = [];
  state.files = [];
  state.typingUsers = [];
  state.searchTerm = "";
  els.chatView.classList.add("hidden");
  els.lobbyView.classList.remove("hidden");
  els.roomCodeInput.focus();
}

async function createRoom() {
  els.createRoomButton.disabled = true;
  try {
    const response = await fetch("/api/rooms", { method: "POST" });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "방 생성 실패");
    }
    socket.emit("joinRoom", { roomCode: data.room.code });
  } catch (error) {
    toast(error.message);
  } finally {
    els.createRoomButton.disabled = false;
  }
}

function joinRoom(code) {
  const roomCode = String(code || "").replace(/\D/g, "").slice(0, 4);
  if (roomCode.length !== 4) {
    toast("4자리 참여 코드를 입력해주세요.");
    return;
  }
  socket.emit("joinRoom", { roomCode });
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
  for (const file of files) {
    body.append("files", file);
  }

  els.pickFileButton.disabled = true;
  els.pickFileButton.textContent = "업로드 중";
  try {
    const response = await fetch(`/api/rooms/${state.room.code}/files`, {
      method: "POST",
      body,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "업로드 실패");
    }
    mergeFiles(data.files || []);
    toast(`${data.files.length}개 파일 업로드 완료`);
  } catch (error) {
    toast(error.message);
  } finally {
    els.fileInput.value = "";
    els.pickFileButton.disabled = false;
    els.pickFileButton.textContent = "파일 선택";
  }
}

function renderTypingLine() {
  const users = state.typingUsers.filter((ip) => ip !== state.meIp);
  els.typingLine.textContent =
    users.length > 0 ? `${users.slice(0, 2).join(", ")} 입력 중` : "";
}

let typingTimer = null;
function signalTyping() {
  if (!state.room) {
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
    els.myIpLabel.textContent = `내 IP ${data.ip}`;
  } catch {
    els.myIpLabel.textContent = "IP 확인 실패";
  }
}

socket.on("connect", () => {
  els.connectionStatus.textContent = "실시간 연결됨";
});

socket.on("disconnect", () => {
  els.connectionStatus.textContent = "연결 끊김";
});

socket.on("errorMessage", toast);

socket.on("roomJoined", enterRoom);

socket.on("messageCreated", (message) => {
  if (!state.room || message.roomCode !== state.room.code) {
    return;
  }
  if (state.messages.some((item) => item.id === message.id)) {
    return;
  }
  state.messages.push(message);
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
});

socket.on("roomDestroyed", ({ roomCode, destroyedByIp }) => {
  if (!state.room || roomCode !== state.room.code) {
    return;
  }
  const ownAction = destroyedByIp === state.meIp;
  leaveRoom({ notifyServer: false });
  toast(ownAction ? "방을 터뜨렸습니다." : "방장이 방을 터뜨렸습니다.");
});

els.createRoomButton.addEventListener("click", createRoom);

els.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  joinRoom(els.roomCodeInput.value);
});

els.roomCodeInput.addEventListener("input", () => {
  els.roomCodeInput.value = els.roomCodeInput.value.replace(/\D/g, "").slice(0, 4);
});

els.copyCodeButton.addEventListener("click", async () => {
  if (!state.room) {
    return;
  }
  await navigator.clipboard.writeText(state.room.code);
  toast("초대 코드를 복사했습니다.");
});

els.leaveRoomButton.addEventListener("click", () => leaveRoom());

els.destroyRoomButton.addEventListener("click", () => {
  if (!state.room || !state.room.isOwner) {
    return;
  }
  const ok = window.confirm("방을 터뜨리면 메시지와 업로드 파일이 모두 삭제됩니다.");
  if (ok) {
    socket.emit("destroyRoom");
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
  const text = els.messageInput.value.trim();
  if (!text) {
    return;
  }
  socket.emit("sendMessage", { text });
  socket.emit("typing", { isTyping: false });
  els.messageInput.value = "";
  els.messageInput.style.height = "auto";
});

loadMe();
