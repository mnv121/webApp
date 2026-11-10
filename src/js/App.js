// ---------------------------------------------------------------
// Login + registration with Supabase Auth, then the chat app.
// Supports: Google, Facebook, email/password, Google One Tap prompt,
// email confirmation, and password reset.
// Your keys live in config.js.
// ---------------------------------------------------------------
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_CLIENT_ID } from "./config.js";
import { startChat, stopChat } from "./chat.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Where Supabase sends people back to after OAuth / email links.
// This exact address must be listed under Authentication > URL Configuration > Redirect URLs.
const REDIRECT_URL = window.location.origin + window.location.pathname;

// ----- DOM references -----
const $ = (id) => document.getElementById(id);
const authView = $("auth-view");
const chatView = $("chat-view");
const recoveryView = $("recovery-view");
const statusEl = $("status");
const loginForm = $("login-form");
const registerForm = $("register-form");
const recoveryForm = $("recovery-form");

let inRecovery = false; // true while the user is setting a new password

// ----- Helpers -----
function setStatus(message, ok = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("ok", ok);
}

function friendlyError(err) {
  const map = {
    invalid_credentials: "Incorrect email or password.",
    email_not_confirmed: "Please confirm your email first. Check your inbox for the link.",
    user_already_exists: "An account with this email already exists. Try signing in instead.",
    weak_password: "Password is too weak. Use at least 8 characters.",
    over_email_send_rate_limit: "Too many emails sent. Please wait a bit and try again.",
    over_request_rate_limit: "Too many attempts. Please wait a bit and try again.",
    validation_failed: "That email address doesn't look right.",
    signup_disabled: "Sign-ups are currently disabled.",
    provider_disabled: "That sign-in method isn't enabled yet in Supabase.",
  };
  return map[err.code] || err.message || "Something went wrong.";
}

async function run(button, task) {
  setStatus("");
  if (button) button.disabled = true;
  try {
    await task();
  } catch (err) {
    console.error(err);
    setStatus(friendlyError(err));
    if (err.code === "email_not_confirmed") $("resend-btn").classList.remove("hidden");
  } finally {
    if (button) button.disabled = false;
  }
}

// Supabase returns { data, error } instead of throwing. This turns errors into throws.
function check({ data, error }) {
  if (error) throw error;
  return data;
}

// ----- Tabs: switch between Sign in and Create account -----
function showTab(which) {
  const isLogin = which === "login";
  loginForm.classList.toggle("hidden", !isLogin);
  registerForm.classList.toggle("hidden", isLogin);
  $("tab-login").classList.toggle("active", isLogin);
  $("tab-register").classList.toggle("active", !isLogin);
  setStatus("");
}
$("tab-login").addEventListener("click", () => showTab("login"));
$("tab-register").addEventListener("click", () => showTab("register"));

// ----- Social login (Google / Facebook) -----
// This redirects to the provider and back. The first time someone uses it,
// an account is created automatically, so one button covers login and sign-up.
$("google-btn").addEventListener("click", (e) =>
  run(e.currentTarget, async () =>
    check(
      await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: REDIRECT_URL },
      })
    )
  )
);

$("facebook-btn").addEventListener("click", (e) =>
  run(e.currentTarget, async () =>
    check(
      await supabase.auth.signInWithOAuth({
        provider: "facebook",
        options: { redirectTo: REDIRECT_URL, scopes: "email" },
      })
    )
  )
);

// ----- Email/password: sign in -----
loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  if (!email || !password) return setStatus("Enter your email and password.");
  run(loginForm.querySelector("button[type=submit]"), async () =>
    check(await supabase.auth.signInWithPassword({ email, password }))
  );
});

// ----- Email/password: registration -----
registerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("reg-name").value.trim();
  const email = $("reg-email").value.trim();
  const password = $("reg-password").value;
  const confirm = $("reg-confirm").value;

  if (!name) return setStatus("Please enter your name.");
  if (password.length < 8) return setStatus("Password must be at least 8 characters.");
  if (password !== confirm) return setStatus("Passwords don't match.");

  run(registerForm.querySelector("button[type=submit]"), async () => {
    const data = check(
      await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: name }, emailRedirectTo: REDIRECT_URL },
      })
    );

    // With email confirmation on, Supabase hides whether an email is already taken,
    // but returns a user with no identities when it is.
    if (data.user && data.user.identities && data.user.identities.length === 0) {
      return setStatus("An account with this email already exists. Try signing in instead.");
    }

    if (!data.session) {
      // Confirmation email sent; user must click the link before signing in.
      showTab("login");
      $("login-email").value = email;
      setStatus("Account created! Check your email and click the confirmation link.", true);
    }
    // If confirmation is turned off, a session exists and onAuthStateChange shows the chat.
  });
});

// ----- Resend confirmation email -----
$("resend-btn").addEventListener("click", () => {
  const email = $("login-email").value.trim();
  if (!email) return setStatus("Type your email above first.");
  run(null, async () => {
    check(
      await supabase.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: REDIRECT_URL },
      })
    );
    setStatus("Confirmation email sent. Check your inbox.", true);
  });
});

// ----- Forgot password -----
$("forgot-btn").addEventListener("click", () => {
  const email = $("login-email").value.trim();
  if (!email) return setStatus("Type your email above first, then click 'Forgot password?'.");
  run(null, async () => {
    check(await supabase.auth.resetPasswordForEmail(email, { redirectTo: REDIRECT_URL }));
    setStatus("Password reset email sent. Check your inbox.", true);
  });
});

// ----- Set a new password (after clicking the reset link in the email) -----
recoveryForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const recoveryStatus = $("recovery-status");
  const password = $("new-password").value;
  const confirm = $("new-confirm").value;
  recoveryStatus.classList.remove("ok");

  if (password.length < 8) return (recoveryStatus.textContent = "Password must be at least 8 characters.");
  if (password !== confirm) return (recoveryStatus.textContent = "Passwords don't match.");

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    recoveryStatus.textContent = friendlyError(error);
    return;
  }
  recoveryStatus.textContent = "Password updated!";
  recoveryStatus.classList.add("ok");
  inRecovery = false;
  setTimeout(async () => {
    const { data } = await supabase.auth.getSession();
    render(data.session);
  }, 800);
});

// ----- Google One Tap: the automatic "Sign in with Google" prompt -----
// Google needs a hashed nonce; Supabase needs the original (raw) one. We create both.
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function setupOneTap() {
  if (GOOGLE_CLIENT_ID.startsWith("YOUR_")) return; // not configured yet
  if (!window.google?.accounts?.id) return;

  const rawNonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const hashedNonce = await sha256Hex(rawNonce);

  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    nonce: hashedNonce,
    callback: (response) =>
      run(null, async () =>
        check(
          await supabase.auth.signInWithIdToken({
            provider: "google",
            token: response.credential,
            nonce: rawNonce,
          })
        )
      ),
    auto_select: false,
    cancel_on_tap_outside: false,
    use_fedcm_for_prompt: true,
  });
  google.accounts.id.prompt();
}

// ----- Showing the right screen -----
function render(session) {
  recoveryView.classList.add("hidden");
  const user = session?.user;

  if (user) {
    authView.classList.add("hidden");
    chatView.classList.remove("hidden");

    // Header of the chat sidebar: who is signed in
    const meta = user.user_metadata || {};
    const displayName = meta.full_name || meta.name || "Welcome!";
    $("user-name").textContent = displayName;
    $("user-email").textContent = user.email || "";

    const holder = $("me-avatar");
    holder.replaceChildren();
    const url = meta.avatar_url || meta.picture;
    if (typeof url === "string" && url.startsWith("https://")) {
      const img = document.createElement("img");
      img.className = "avatar-sm";
      img.src = url;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      holder.append(img);
    } else {
      const d = document.createElement("div");
      d.className = "avatar-sm initials";
      d.textContent = displayName.trim().charAt(0).toUpperCase() || "?";
      holder.append(d);
    }

    startChat(supabase, user);
  } else {
    stopChat();
    chatView.classList.add("hidden");
    authView.classList.remove("hidden");
    // Offer the One Tap prompt once the Google library has loaded
    if (document.readyState === "complete") setupOneTap();
    else window.addEventListener("load", setupOneTap, { once: true });
  }
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") {
    inRecovery = true;
    stopChat();
    authView.classList.add("hidden");
    chatView.classList.add("hidden");
    recoveryView.classList.remove("hidden");
    return;
  }
  if (inRecovery) return; // stay on the new-password screen until it's done
  render(session);
});

$("logout-btn").addEventListener("click", () => supabase.auth.signOut());