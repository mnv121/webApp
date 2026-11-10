// ---------------------------------------------------------------
// Messenger-style chat: conversation list, live messages, unread
// badges, and finding people by username.
// Security: all text is inserted with textContent (never innerHTML),
// and access is enforced by the database's Row Level Security.
// ---------------------------------------------------------------

let sb = null; // Supabase client
let me = null; // signed-in user
let activeId = null; // open conversation id
let channel = null; // realtime subscription
let convos = [];
let bound = false;
let refreshTimer = null;
const seen = new Set(); // message ids already on screen
let pendingFile = null; // file chosen but not sent yet
let sending = false;

// Attachments: must match the limits in attachments_schema.sql (the server enforces them too)
const BUCKET = "chat-files";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ALLOWED_TYPES = new Set([
  ...IMAGE_TYPES,
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg",
  "video/mp4", "video/webm",
]);
const MESSAGE_COLS =
  "id, sender_id, body, created_at, attachment_path, attachment_name, attachment_type, attachment_size";

const $ = (id) => document.getElementById(id);

// ----- small helpers -----
function avatarEl(url, name) {
  if (typeof url === "string" && url.startsWith("https://")) {
    const img = document.createElement("img");
    img.className = "avatar-sm";
    img.src = url;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    return img;
  }
  const d = document.createElement("div");
  d.className = "avatar-sm initials";
  d.textContent = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return d;
}

function peerLabel(c) {
  return c.peer_name || (c.peer_username ? "@" + c.peer_username : "Unknown user");
}

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function setFindStatus(message, ok = false) {
  const el = $("find-status");
  el.textContent = message;
  el.classList.toggle("ok", ok);
}

function setSendStatus(message, ok = false) {
  const el = $("send-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("ok", ok);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// ----- attachments -----
function clearAttachment() {
  pendingFile = null;
  const input = $("attach-input");
  if (input) input.value = "";
  $("attach-chip")?.classList.add("hidden");
}

function pickAttachment(file) {
  if (!file) return;
  setSendStatus("");
  if (file.size === 0) return setSendStatus("That file is empty.");
  if (file.size > MAX_BYTES) {
    return setSendStatus(`File is too big (${formatSize(file.size)}). The limit is 10 MB.`);
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return setSendStatus("That file type isn't allowed. Try an image, PDF, document, zip, audio or video.");
  }
  pendingFile = file;
  $("attach-name").textContent = `${file.name} (${formatSize(file.size)})`;
  $("attach-chip").classList.remove("hidden");
}

// Files are private: we ask Supabase for a short-lived signed link each time.
async function signedUrl(path, seconds, downloadName) {
  if (!sb) return null;
  const options = downloadName ? { download: downloadName } : undefined;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, seconds, options);
  return error ? null : data.signedUrl;
}

function fileButton(m) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "att-file";
  const icon = document.createElement("span");
  icon.textContent = "📎";
  const name = document.createElement("span");
  name.className = "att-name";
  name.textContent = m.attachment_name || "file";
  btn.append(icon, name);
  if (m.attachment_size) {
    const size = document.createElement("small");
    size.textContent = formatSize(m.attachment_size);
    btn.append(size);
  }
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const url = await signedUrl(m.attachment_path, 60, m.attachment_name);
    btn.disabled = false;
    if (!url) return setSendStatus("Couldn't open that file.");
    const a = document.createElement("a");
    a.href = url;
    a.download = m.attachment_name || "file";
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
  });
  return btn;
}

function attachmentEl(m) {
  if (!IMAGE_TYPES.has(m.attachment_type)) return fileButton(m);

  const img = document.createElement("img");
  img.className = "att-img";
  img.alt = m.attachment_name || "image";
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  let url = null;
  img.addEventListener("load", () => {
    const box = $("messages");
    if (box) box.scrollTop = box.scrollHeight;
  });
  img.addEventListener("click", () => {
    if (url) window.open(url, "_blank", "noopener");
  });
  signedUrl(m.attachment_path, 3600).then((u) => {
    if (u) {
      url = u;
      img.src = u;
    } else {
      img.replaceWith(fileButton(m)); // fall back to a download button
    }
  });
  return img;
}

// ----- conversation list -----
async function refreshList() {
  if (!sb) return;
  const { data, error } = await sb.rpc("my_conversations");
  if (error) return setFindStatus(error.message);
  convos = data || [];
  renderList();
}

function refreshListSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshList, 150);
}

function renderList() {
  const list = $("convo-list");
  list.replaceChildren();

  if (!convos.length) {
    const li = document.createElement("li");
    li.className = "convo-empty";
    li.textContent = "No chats yet. Find someone by username above.";
    list.append(li);
    return;
  }

  for (const c of convos) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "convo";
    if (c.conversation_id === activeId) btn.classList.add("active");
    if (c.unread > 0) btn.classList.add("unread");

    const main = document.createElement("div");
    main.className = "convo-main";
    const name = document.createElement("div");
    name.className = "convo-name";
    name.textContent = peerLabel(c);
    const preview = document.createElement("div");
    preview.className = "convo-preview";
    preview.textContent = c.last_body
      ? (c.last_sender === me.id ? "You: " : "") + c.last_body
      : "Say hi 👋";
    main.append(name, preview);

    const side = document.createElement("div");
    side.className = "convo-side";
    if (c.last_at) {
      const t = document.createElement("small");
      t.textContent = formatTime(c.last_at);
      side.append(t);
    }
    if (c.unread > 0) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = c.unread > 99 ? "99+" : String(c.unread);
      side.append(b);
    }

    btn.append(avatarEl(c.peer_avatar, peerLabel(c)), main, side);
    btn.addEventListener("click", () => openConversation(c));
    li.append(btn);
    list.append(li);
  }
}

// ----- open a conversation -----
async function openConversation(c) {
  clearAttachment(); // never carry a chosen file over into a different chat
  setSendStatus("");
  activeId = c.conversation_id;
  $("peer-name").textContent = peerLabel(c);
  $("peer-avatar").replaceChildren(avatarEl(c.peer_avatar, peerLabel(c)));
  $("thread-empty").classList.add("hidden");
  $("thread-body").classList.remove("hidden");
  $("chat-view").classList.add("show-thread");

  await loadMessages(activeId);
  await markRead(activeId);
  await refreshList();
  $("msg-input").focus();
}

async function loadMessages(id) {
  const box = $("messages");
  box.replaceChildren();
  seen.clear();

  const { data, error } = await sb
    .from("messages")
    .select(MESSAGE_COLS)
    .eq("conversation_id", id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (id !== activeId) return; // user switched chats while loading
  if (error) return setFindStatus(error.message);
  for (const m of (data || []).reverse()) appendMessage(m);
}

function appendMessage(m) {
  if (seen.has(m.id)) return;
  seen.add(m.id);

  const box = $("messages");
  const div = document.createElement("div");
  div.className = "msg " + (m.sender_id === me.id ? "me" : "them");
  div.title = new Date(m.created_at).toLocaleString();
  if (m.attachment_path) {
    div.classList.add("has-file");
    div.append(attachmentEl(m));
    if (m.body) {
      const text = document.createElement("div");
      text.className = "att-text";
      text.textContent = m.body;
      div.append(text);
    }
  } else {
    div.textContent = m.body;
  }
  box.append(div);
  box.scrollTop = box.scrollHeight;
}

async function markRead(id) {
  if (!sb) return;
  await sb.rpc("mark_conversation_read", { conv: id });
}

// ----- realtime: new messages arrive instantly -----
async function onNewMessage(m) {
  if (m.conversation_id === activeId) {
    appendMessage(m);
    if (m.sender_id !== me.id) await markRead(activeId);
  }
  refreshListSoon();
}

function subscribe() {
  channel = sb
    .channel("messages-feed")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      (payload) => onNewMessage(payload.new)
    )
    .subscribe();
}

// ----- UI events (bound once) -----
function bindUI() {
  if (bound) return;
  bound = true;

  // Send a message
  $("send-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sb || !activeId || sending) return;
    const input = $("msg-input");
    const body = input.value.trim();
    const file = pendingFile;
    if (!body && !file) return;

    sending = true;
    $("send-btn").disabled = true;
    setSendStatus("");
    const convId = activeId;

    try {
      let attachment = {};
      if (file) {
        setSendStatus("Uploading…", true);
        // Files live under "<conversation id>/", which is what the access rules check.
        const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "file";
        const path = `${convId}/${crypto.randomUUID()}-${safe}`;
        const { error: upErr } = await sb.storage
          .from(BUCKET)
          .upload(path, file, { contentType: file.type, upsert: false });
        if (upErr) throw upErr;
        attachment = {
          attachment_path: path,
          attachment_name: file.name.slice(0, 255),
          attachment_type: file.type,
          attachment_size: file.size,
        };
      }

      const { data, error } = await sb
        .from("messages")
        .insert({ conversation_id: convId, body, ...attachment })
        .select(MESSAGE_COLS)
        .single();
      if (error) throw error;

      input.value = "";
      clearAttachment();
      setSendStatus("");
      if (convId === activeId) appendMessage(data);
      refreshListSoon();
    } catch (err) {
      // Text and chosen file are kept so nothing is lost; the user can retry.
      setSendStatus("Couldn't send: " + (err.message || err));
    } finally {
      sending = false;
      const btn = $("send-btn");
      if (btn) btn.disabled = false;
    }
  });

  // Attach a file: paperclip button, the chip's X, or drag and drop onto the chat
  $("attach-btn").addEventListener("click", () => $("attach-input").click());
  $("attach-input").addEventListener("change", (e) => pickAttachment(e.target.files[0]));
  $("attach-clear").addEventListener("click", () => {
    clearAttachment();
    setSendStatus("");
  });
  const dropZone = $("thread-body");
  dropZone.addEventListener("dragover", (e) => e.preventDefault());
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    pickAttachment(e.dataTransfer?.files?.[0]);
  });

  // Find someone by username and start a chat
  $("find-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sb) return;
    const name = $("find-input").value.trim().replace(/^@/, "").toLowerCase();
    if (!name) return;
    setFindStatus("");

    const { data, error } = await sb.rpc("find_user_by_username", { uname: name });
    if (error) return setFindStatus(error.message);
    if (!data || !data.length) return setFindStatus("No user with that username.");

    const { data: convId, error: err2 } = await sb.rpc("start_dm", { other_user: data[0].id });
    if (err2) return setFindStatus(err2.message);

    $("find-input").value = "";
    await refreshList();
    const c = convos.find((x) => x.conversation_id === convId);
    if (c) openConversation(c);
  });

  // Choose your own username (needed so others can find you)
  $("username-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sb) return;
    const name = $("username-input").value.trim().toLowerCase();
    const status = $("username-status");
    status.classList.remove("ok");
    if (!/^[a-z0-9_]{3,30}$/.test(name)) {
      status.textContent = "3-30 characters: letters, numbers, underscore.";
      return;
    }
    const { error } = await sb.from("profiles").update({ username: name }).eq("id", me.id);
    if (error) {
      status.textContent =
        error.code === "23505" ? "That username is taken." : error.message;
      return;
    }
    $("username-box").classList.add("hidden");
    setFindStatus(`Your username is @${name}. Share it so friends can find you.`, true);
  });

  // Mobile: back to the chat list
  $("back-btn").addEventListener("click", () => {
    $("chat-view").classList.remove("show-thread");
  });
}

async function checkUsername() {
  const { data } = await sb.from("profiles").select("username").eq("id", me.id).maybeSingle();
  $("username-box").classList.toggle("hidden", !!data?.username);
}

// ----- public API used by app.js -----
export async function startChat(supabase, user) {
  if (me && me.id === user.id) return; // already running for this user
  stopChat();
  sb = supabase;
  me = user;
  bindUI();
  await checkUsername();
  await refreshList();
  subscribe();
}

export function stopChat() {
  clearTimeout(refreshTimer);
  if (channel && sb) sb.removeChannel(channel);
  channel = null;
  sb = null;
  me = null;
  activeId = null;
  convos = [];
  seen.clear();
  sending = false;
  clearAttachment();
  setSendStatus("");

  $("convo-list")?.replaceChildren();
  $("messages")?.replaceChildren();
  $("thread-body")?.classList.add("hidden");
  $("thread-empty")?.classList.remove("hidden");
  $("chat-view")?.classList.remove("show-thread");
}