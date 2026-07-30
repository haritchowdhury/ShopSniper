export function scoreLead({
  relevanceScore,
  shopifyConfidence,
  identityConfidence,
  email,
  phone,
  contactUrl,
  socialProfiles = []
}) {
  const relevancePoints = Math.round((relevanceScore / 100) * 30);
  const storefrontPoints = Math.round((shopifyConfidence / 100) * 25);
  const identityPoints = Math.round((identityConfidence / 100) * 20);
  let contactPoints = 0;
  if (email) contactPoints += 12;
  if (phone) contactPoints += 7;
  if (contactUrl) contactPoints += 4;
  if (socialProfiles.length) contactPoints += 2;

  return Math.min(
    100,
    relevancePoints + storefrontPoints + identityPoints + Math.min(25, contactPoints)
  );
}
