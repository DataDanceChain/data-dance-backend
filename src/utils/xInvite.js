const INVITE_PATH = 'app.datadance.ai/user/wheel';

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function mentionsInvite(tweet) {
  const text = String(tweet?.text || '');
  if (text.includes(INVITE_PATH)) return true;
  const urls = Array.isArray(tweet?.entities?.urls) ? tweet.entities.urls : [];
  return urls.some((item) => {
    const value = `${item?.expanded_url || ''} ${item?.unwound_url || ''} ${item?.display_url || ''}`;
    return value.includes(INVITE_PATH);
  });
}

/** A public invite posted by the bound account on this UTC day. */
function invitePostOnDay(tweet, now) {
  if (!mentionsInvite(tweet)) return false;
  const created = new Date(tweet?.created_at || '');
  if (Number.isNaN(created.getTime())) return false;
  return startOfUtcDay(created).toISOString() === startOfUtcDay(now).toISOString();
}

module.exports = {
  INVITE_PATH,
  invitePostOnDay,
};
