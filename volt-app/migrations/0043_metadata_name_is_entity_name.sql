-- THE METADATA NAME IS THE ENTITY'S NAME. A channel, station or event has one
-- required name (Settings). Its content type also has a required `name` field,
-- which the forms showed as a second, separately editable "EPG name" that could
-- drift from the real one. From now on the API always writes the entity's name
-- into metadata.name and the forms hide that field. This brings existing rows
-- into line once.
UPDATE channels SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{name}', to_jsonb(name))
 WHERE metadata->>'name' IS DISTINCT FROM name;
UPDATE events SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{name}', to_jsonb(name))
 WHERE metadata->>'name' IS DISTINCT FROM name;
