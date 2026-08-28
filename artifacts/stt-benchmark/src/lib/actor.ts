// T-49: the one place the signed-in person is defined. The sidebar shows
// this and every API request carries `actor.label` as `x-actor`, so what
// the UI says and what the audit log records are the same name. There is
// no login yet; when there is, this becomes whatever the session says.
export const actor = {
  label: "Abhishek",
  role: "Curator",
  initials: "AS",
} as const
