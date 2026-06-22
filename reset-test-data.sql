UPDATE households
SET
  value = json_set(
    value,
    '$.tasks', json('[]'),
    '$.pointEvents', json('[]'),
    '$.notifications', json('[]'),
    '$.rewardClaims', json('[]')
  ),
  updated_at = datetime('now')
WHERE value IS NOT NULL;
