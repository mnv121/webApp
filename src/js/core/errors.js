// Turns database / auth errors into sentences a person can act on.

export function friendly(err) {
  if (!err) return "";
  const msg = err.message || "";
  if (err.code === "23505") return "That already exists (duplicate email, name, code or date).";
  if (err.code === "42501" || /row-level security|permission denied|^Not allowed/i.test(msg))
    return "You don't have permission to do that.";
  if (err.code === "23514") return "One of the values isn't valid. Check the fields and try again.";
  if (err.code === "42883" || err.code === "42P01" || err.code === "PGRST202" || err.code === "PGRST205")
    return "This part isn't set up yet. Run the latest SQL files in Supabase, then reload. (" + msg + ")";
  return msg || "Something went wrong.";
}
