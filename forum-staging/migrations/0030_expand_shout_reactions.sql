ALTER TABLE shout_reactions
  DROP CONSTRAINT shout_reactions_reaction_check;

ALTER TABLE shout_reactions
  ADD CONSTRAINT shout_reactions_reaction_check
  CHECK (
    char_length(reaction) BETWEEN 1 AND 16
    AND octet_length(reaction) <= 64
    AND reaction !~ '[[:cntrl:][:space:]]'
  );