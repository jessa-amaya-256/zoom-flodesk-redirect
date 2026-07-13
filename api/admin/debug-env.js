/**
 * /api/admin/debug-env
 *
 * TEMPORARY. Diagnostic only — reports structural facts about the
 * admin env vars (length, stray whitespace, stray quote characters)
 * WITHOUT ever returning the actual values, so it's safe to hit over
 * plain HTTP for a few minutes of debugging.
 *
 * DELETE THIS FILE the moment you're done. Don't leave it live —
 * same lesson as api/debug.js from the earlier cleanup item.
 */

function inspect(val) {
  if (typeof val === 'undefined') {
    return { isSet: false };
  }
  return {
    isSet: true,
    length: val.length,
    hasLeadingWhitespace: /^\s/.test(val),
    hasTrailingWhitespace: /\s$/.test(val),
    startsWithQuote: val.startsWith('"') || val.startsWith("'"),
    endsWithQuote: val.endsWith('"') || val.endsWith("'"),
    firstChar: JSON.stringify(val[0]),
    lastChar: JSON.stringify(val[val.length - 1]),
  };
}

module.exports = async (req, res) => {
  res.status(200).json({
    ADMIN_SECRET: inspect(process.env.ADMIN_SECRET),
    VERCEL_API_TOKEN: inspect(process.env.VERCEL_API_TOKEN),
    EDGE_CONFIG_ID: inspect(process.env.EDGE_CONFIG_ID),
  });
};
