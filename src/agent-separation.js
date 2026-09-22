import { Vector3, Quaternion } from '../vendor/three/build/three.module.min.js';

export function createAgentSeparation({ radius, minDistance, hardDistance }) {
  const here = new Vector3(), other = new Vector3(), tangent = new Vector3();
  const normal = new Vector3(), axis = new Vector3(), away = new Vector3();
  const rotation = new Quaternion();

  function tangentFrom(dir) {
    tangent.copy(here).sub(other).normalize();
    tangent.sub(normal.copy(dir).multiplyScalar(tangent.dot(dir)));
  }

  // The returned vector is borrowed until the next steer call; consume it immediately.
  function steer(dir, neighbors, exclude, playerDir) {
    here.copy(dir).multiplyScalar(radius);
    away.set(0, 0, 0);
    for (let i = 0; i <= neighbors.length; i++) {
      if (i < neighbors.length && neighbors[i] === exclude) continue;
      const otherDir = i < neighbors.length ? neighbors[i].userData.dir : playerDir;
      other.copy(otherDir).multiplyScalar(radius);
      const distance = here.distanceTo(other);
      if (distance < minDistance && distance > 1e-4) {
        tangentFrom(dir);
        away.add(tangent.multiplyScalar((minDistance - distance) / minDistance));
      }
    }
    return away;
  }

  function resolve(dir, neighbors, exclude, playerDir) {
    here.copy(dir).multiplyScalar(radius);
    for (let i = 0; i <= neighbors.length; i++) {
      if (i < neighbors.length && neighbors[i] === exclude) continue;
      const otherDir = i < neighbors.length ? neighbors[i].userData.dir : playerDir;
      other.copy(otherDir).multiplyScalar(radius);
      const distance = here.distanceTo(other);
      if (distance < hardDistance && distance > 1e-4) {
        tangentFrom(dir);
        if (tangent.lengthSq() > 1e-6) {
          axis.crossVectors(dir, tangent.normalize()).normalize();
          rotation.setFromAxisAngle(axis, (hardDistance - distance) / radius);
          dir.applyQuaternion(rotation).normalize();
          here.copy(dir).multiplyScalar(radius);
        }
      }
    }
  }

  return { steer, resolve };
}
