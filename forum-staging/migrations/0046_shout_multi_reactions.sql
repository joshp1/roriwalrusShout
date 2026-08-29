ALTER TABLE shout_reactions
  DROP CONSTRAINT shout_reactions_pkey;

ALTER TABLE shout_reactions
  ADD PRIMARY KEY (shout_id, account_id, reaction);