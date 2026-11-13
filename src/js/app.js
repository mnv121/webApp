// ---------------------------------------------------------------
// Entry point: decides which screen to show (sign in / app / new password)
// and starts or stops the app for the signed-in person.
// Your keys live in config.js. Everything else lives in the folders next to this file:
//   core/     shared helpers      auth/     sign-in forms
//   shell/    menu, search, bell  modules/  Home, Leave, Attendance, HR, Approvals, Chat
// ---------------------------------------------------------------
import { supabase } from "./core/supabase.js";
import { initSession, clearSession, friendly, $, el, showScreen } from "./core/ui.js";
import { initAuth } from "./auth/auth.js";
import { initShell, startShell, stopShell } from "./shell/shell.js";
import { startChat, stopChat } from "./modules/chat/chat.js";

let inRecovery = false; // true while the user is setting a new password

const auth = initAuth(supabase, {
  onPasswordChanged: async () => {
    inRecovery = false;
    const { data } = await supabase.auth.getSession();
    render(data.session);
  },
});
initShell();
$("logout-btn").addEventListener("click", () => supabase.auth.signOut());

function render(session) {
  const user = session?.user;

  if (user) {
    showScreen("app");
    startChat(supabase, user);
    initSession(supabase, user)
      .then(() => startShell())
      .catch((err) => {
        console.error(err);
        $("home-view").querySelector("[data-body]").replaceChildren(
          el("p", {
            class: "status",
            text:
              "HR isn't set up yet. Run the SQL files in the sql/ folder (04 and 05) in the Supabase SQL editor, then reload. (" +
              friendly(err) + ")",
          })
        );
      });
  } else {
    stopChat();
    stopShell();
    clearSession();
    showScreen("auth");
    auth.offerOneTap();
  }
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") {
    inRecovery = true;
    stopChat();
    stopShell();
    showScreen("recovery");
    return;
  }
  if (inRecovery) return; // stay on the new-password screen until it's done
  render(session);
});
