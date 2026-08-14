export function planModelSwitch(profiles, activeProfileId) {
  const source = profiles.find((profile) => profile.id === activeProfileId)
  if (source === undefined) throw new Error(`Active model profile is missing: ${activeProfileId}`)
  if (!source.hasApiKey) throw new Error(`Active model profile has no credential: ${activeProfileId}`)
  const target = profiles.find((profile) => profile.id !== activeProfileId && profile.model !== source.model)
  if (target === undefined) return undefined
  const switchProfiles = profiles.map((profile) => profile.id === target.id
    ? { ...profile, credentialRef: source.credentialRef, hasApiKey: true, apiKey: "" }
    : profile)
  return { source, target, switchProfiles }
}
