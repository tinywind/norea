-- Keep user-set work metadata apart from source metadata so no refresh or install can change it.
CREATE TABLE novel_override (
  novel_id INTEGER PRIMARY KEY NOT NULL REFERENCES novel(id) ON DELETE CASCADE,
  payload TEXT NOT NULL
);
