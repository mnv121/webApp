// ---------------------------------------------------------------
// Facebook/Messenger-style chat: conversation list, live messages,
// grouped bubbles with avatars, "Active now", typing indicator,
// "Seen", unread badges, attachments, and finding people by username.
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
let activePeer = null; // the conversation object that is open (peer name, avatar, id)
let lastMsg = null; // newest message on screen: { sender, at, row, mine }
let peerReadAt = null; // when the other person last read this chat (for "Seen")

// Presence ("Active now") and typing share one realtime channel.
// Anyone who can reach the channel sees which user ids are online and which
// chat id they are typing in (random ids, no names or message text).
let presenceCh = null;
let online = {}; // userId -> [{ typing_in }]
let onlineSig = "";
let typingFor = null;
let typingSentAt = 0;
let typingTimer = null;

const GROUP_MS = 5 * 60 * 1000; // messages closer than this stack into one group
const SEP_MS = 15 * 60 * 1000; // a gap this long gets a time divider

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
function avatarEl(url, name, cls = "avatar-sm") {
  if (typeof url === "string" && url.startsWith("https://")) {
    const img = document.createElement("img");
    img.className = cls;
    img.src = url;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    return img;
  }
  const d = document.createElement("div");
  d.className = cls + " initials";
  d.textContent = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return d;
}

const isOnline = (uid) => !!uid && !!online[uid]?.length;
const isTypingIn = (uid, conv) => (online[uid] || []).some((m) => m.typing_in === conv);

// Avatar with the green "active" dot, like Facebook.
function avatarWithDot(url, name, uid) {
  const wrap = document.createElement("span");
  wrap.className = "avatar-wrap";
  wrap.append(avatarEl(url, name));
  if (isOnline(uid)) {
    const dot = document.createElement("i");
    dot.className = "dot";
    wrap.append(dot);
  }
  return wrap;
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
  const open = convos.find((c) => c.conversation_id === activeId);
  if (open) activePeer = open;
  renderList();
  updatePeerHeader();
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

    btn.append(avatarWithDot(c.peer_avatar, peerLabel(c), c.peer_id), main, side);
    btn.addEventListener("click", () => openConversation(c));
    li.append(btn);
    list.append(li);
  }
}

// ----- open a conversation -----
async function openConversation(c) {
  clearAttachment(); // never carry a chosen file over into a different chat
  setSendStatus("");
  stopTyping();
  activeId = c.conversation_id;
  activePeer = c;
  peerReadAt = null;
  $("peer-name").textContent = peerLabel(c);
  updatePeerHeader();
  $("thread-empty").classList.add("hidden");
  $("thread-body").classList.remove("hidden");
  $("chat-view").classList.add("show-thread");

  await loadPeerRead(activeId);
  await loadMessages(activeId);
  await markRead(activeId);
  await refreshList();
  $("msg-input").focus();
}

async function loadMessages(id) {
  const box = $("messages");
  box.replaceChildren();
  seen.clear();
  lastMsg = null;

  const { data, error } = await sb
    .from("messages")
    .select(MESSAGE_COLS)
    .eq("conversation_id", id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (id !== activeId) return; // user switched chats while loading
  if (error) return setFindStatus(error.message);
  for (const m of (data || []).reverse()) appendMessage(m);
  updateTyping();
}

function dividerLabel(ms) {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const opts = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString([], opts) + ", " + time;
}

function appendMessage(m) {
  if (seen.has(m.id)) return;
  seen.add(m.id);

  const box = $("messages");
  $("seen-line")?.remove(); // re-added after the new message
  const mine = m.sender_id === me.id;
  const at = new Date(m.created_at).getTime();
  const prev = lastMsg;

  // Time divider when there is a long gap or a new day
  const needDivider =
    !prev || at - prev.at > SEP_MS || new Date(prev.at).toDateString() !== new Date(at).toDateString();
  if (needDivider) {
    const sep = document.createElement("div");
    sep.className = "time-sep";
    sep.textContent = dividerLabel(at);
    box.append(sep);
  }

  // Group consecutive messages from the same person (tight corners, one avatar)
  const grouped = !needDivider && prev.sender === m.sender_id && at - prev.at <= GROUP_MS;
  if (grouped) {
    const pr = prev.row;
    if (pr.classList.contains("single")) pr.classList.replace("single", "first");
    else if (pr.classList.contains("last")) pr.classList.replace("last", "mid");
  }

  const row = document.createElement("div");
  row.className = "row " + (mine ? "mine" : "theirs") + (grouped ? " last" : " single");

  if (!mine) {
    row.append(
      avatarEl(activePeer?.peer_avatar, activePeer ? peerLabel(activePeer) : "?", "avatar-xs")
    );
  }

  const bubble = document.createElement("div");
  bubble.className = "msg";
  bubble.title = new Date(m.created_at).toLocaleString();
  if (m.attachment_path) {
    bubble.classList.add("has-file");
    bubble.append(attachmentEl(m));
    if (m.body) {
      const text = document.createElement("div");
      text.className = "att-text";
      text.textContent = m.body;
      bubble.append(text);
    }
  } else {
    bubble.textContent = m.body;
  }
  row.append(bubble);
  box.append(row);

  lastMsg = { sender: m.sender_id, at, row, mine };
  renderSeen();
  box.scrollTop = box.scrollHeight;
}

// "Sent" / "Seen" under my newest message
function renderSeen() {
  $("seen-line")?.remove();
  if (!lastMsg || !lastMsg.mine) return;
  const line = document.createElement("div");
  line.id = "seen-line";
  line.className = "seen-line";
  const read = peerReadAt && new Date(peerReadAt).getTime() >= lastMsg.at;
  line.textContent = read ? "Seen" : "Sent";
  $("messages").append(line);
}

async function loadPeerRead(id) {
  const { data } = await sb
    .from("conversation_members")
    .select("user_id, last_read_at")
    .eq("conversation_id", id)
    .neq("user_id", me.id);
  if (id !== activeId) return;
  peerReadAt = data?.[0]?.last_read_at ?? null;
}

// ----- presence + typing -----
function updatePeerHeader() {
  if (!activePeer) return;
  const uid = activePeer.peer_id;
  $("peer-avatar").replaceChildren(avatarWithDot(activePeer.peer_avatar, peerLabel(activePeer), uid));
  const status = $("peer-status");
  status.textContent = isOnline(uid) ? "Active now" : "";
  status.classList.toggle("active-now", isOnline(uid));
  updateTyping();
}

function updateTyping() {
  const box = $("typing");
  if (!box) return;
  const on = !!activePeer && !!activeId && isTypingIn(activePeer.peer_id, activeId);
  box.classList.toggle("hidden", !on);
  if (on) {
    const m = $("messages");
    m.scrollTop = m.scrollHeight;
  }
}

function joinPresence() {
  presenceCh = sb.channel("presence-lobby", { config: { presence: { key: me.id } } });
  presenceCh
    .on("presence", { event: "sync" }, () => {
      online = presenceCh.presenceState();
      const sig = Object.keys(online).sort().join(",");
      if (sig !== onlineSig) {
        onlineSig = sig;
        renderList(); // green dots in the chat list
      }
      updatePeerHeader();
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") await presenceCh.track({ typing_in: null });
    });
}

function signalTyping() {
  if (!presenceCh || !activeId) return;
  const now = Date.now();
  if (typingFor !== activeId || now - typingSentAt > 2500) {
    typingFor = activeId;
    typingSentAt = now;
    presenceCh.track({ typing_in: activeId });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 3000);
}

function stopTyping() {
  clearTimeout(typingTimer);
  if (typingFor && presenceCh) presenceCh.track({ typing_in: null });
  typingFor = null;
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
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "conversation_members" },
      (payload) => {
        const row = payload.new;
        if (row.user_id !== me.id && row.conversation_id === activeId) {
          peerReadAt = row.last_read_at;
          renderSeen();
        }
      }
    )
    .subscribe();
  joinPresence();
}

// ----- UI events (bound once) -----
function bindUI() {
  if (bound) return;
  bound = true;

  $("msg-input").addEventListener("input", signalTyping);
  $("msg-input").addEventListener("blur", stopTyping);

  // Send a message
  $("send-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sb || !activeId || sending) return;
    stopTyping();
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
  clearTimeout(typingTimer);
  if (channel && sb) sb.removeChannel(channel);
  if (presenceCh && sb) sb.removeChannel(presenceCh);
  channel = null;
  presenceCh = null;
  online = {};
  onlineSig = "";
  typingFor = null;
  activePeer = null;
  lastMsg = null;
  peerReadAt = null;
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