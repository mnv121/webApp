# Workspace (HR + chat web app)

```
index.html                    page shell (login, side menu, top bar, chat bubble, dialogs)
sql/                          run in Supabase SQL editor, in number order (01 -> 05)
src/
  webappcss/  base, auth, layout, components, dashboard, chat
  js/
    config.js                 YOUR Supabase URL + keys (not part of the zip)
    app.js                    entry point: which screen to show
    core/                     shared helpers (state, dom, format, icons, dialog, tabs, session, supabase)
    auth/auth.js              sign in / register / reset password / Google One Tap
    shell/                    side menu, search (Ctrl K), bell, account menu
    modules/
      home/ leave/ attendance/ hr/ approvals/ chat/
```

Add a new page: make `modules/<name>/<name>.js` exporting `show…` and `stop…`,
add a `<section class="view">` in index.html, and one line in `SECTIONS` in `shell/shell.js`.
