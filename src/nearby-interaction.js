// Angular distances on the planet: residents can be approached on foot,
// while houses use their actual door position.
export function selectNearbyInteraction({
  blocked = false, activeBoat = null, nearbyBoat = null,
  residents = [], homes = [],
} = {}) {
  if (blocked) return null;
  if (activeBoat) return { kind: 'boat-exit', target: activeBoat };
  if (nearbyBoat) return { kind: 'boat-enter', target: nearbyBoat };
  for (const [kind, candidates, radius] of [
    ['resident', residents, 0.18], ['home', homes, 0.18],
  ]) {
    let nearest = null, distance = radius;
    for (const candidate of candidates) {
      if (candidate.target && candidate.distance >= 0 && candidate.distance < distance) {
        nearest = candidate.target;
        distance = candidate.distance;
      }
    }
    if (nearest) return { kind, target: nearest };
  }
  return null;
}
