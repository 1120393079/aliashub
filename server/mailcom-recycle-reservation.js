function normalizedEmails(values = []) {
  return [...new Set(values
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean))];
}

export function mailcomRecyclingReservations(db, values = []) {
  const emails = normalizedEmails(values);
  if (!db || !emails.length) return new Map();
  const placeholders = emails.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT items.id, items.pipeline_id, items.account_id, items.current_address_id,
      items.current_email, items.replacement_email, items.status, items.stage,
      attempts.email AS attempt_email, attempts.recycle_status
    FROM mailcom_registration_pipeline_items AS items
    LEFT JOIN mailcom_registration_pipeline_attempts AS attempts
      ON attempts.id = items.current_attempt_id AND attempts.item_id = items.id
    WHERE (
      items.current_email IN (${placeholders})
      OR items.replacement_email IN (${placeholders})
      OR attempts.email IN (${placeholders})
    ) AND (
      (
        items.stage IN ('recycling', 'recycle_retry_wait')
        AND items.status IN ('queued', 'running', 'retry_wait', 'cancel_requested')
      )
      OR attempts.recycle_status = 'running'
    )
  `).all(...emails, ...emails, ...emails);
  const reservations = new Map();
  rows.forEach((row) => {
    [row.current_email, row.replacement_email, row.attempt_email].forEach((value) => {
      const email = String(value || "").trim().toLowerCase();
      if (email) reservations.set(email, row);
    });
  });
  return reservations;
}

export function mailcomRecyclingReservation(db, value) {
  const email = String(value || "").trim().toLowerCase();
  return email ? mailcomRecyclingReservations(db, [email]).get(email) || null : null;
}
