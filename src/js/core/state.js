// Shared app state: who is signed in and what they may do.
// The database enforces every rule; this is only used to decide what to SHOW.

export const ctx = { sb: null, me: null, access: null, tz: "UTC" };

export const $ = (id) => document.getElementById(id);
export const can = (perm) => !!ctx.access?.permissions?.includes(perm);

export const ROLE_LABELS = {
  owner: "Owner",
  system_admin: "System Admin",
  admin_1: "Admin Level 1",
  admin_2: "Admin Level 2",
  admin_3: "Admin Level 3",
  employee: "Employee",
};
