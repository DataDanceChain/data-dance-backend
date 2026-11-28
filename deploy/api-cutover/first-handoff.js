'use strict';

// For a single ingress owner observing ALL admissions in a disjoint route family.
// Start the observation clock only after previously unobserved ingress has drained.
// commitOwner must durably select the target before any request reaches it.
function trackFamily({ lifetimeMs, initialOwner, commitOwner, now = () => performance.now() }) {
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 ||
      !['legacy', 'shared'].includes(initialOwner) || typeof commitOwner !== 'function') {
    throw new Error('Invalid first-migration configuration');
  }
  let owner = initialOwner;
  let lastCompletion = now();
  let pending = 0;
  let observed = false;
  return {
    startObservation(proof) {
      // A socket can disconnect while its handler continues. Require both
      // observations. Missing values must never be interpreted as zero.
      observed = proof?.ingressVerified === true && proof.directConnections === 0 &&
        proof.unresolvedLegacyWrites === 0;
      if (observed) lastCompletion = now();
      return observed;
    },
    invalidateObservation() {
      // In particular, preserve requests still outstanding through a routing inverse.
      observed = false;
    },
    admit() {
      if (owner === 'legacy' && observed && pending === 0 && now() - lastCompletion > lifetimeMs) {
        // Synchronous compare-and-set. Unknown outcome must surface to the caller,
        // so it can re-read the owner before accepting another request.
        if (commitOwner() !== true) throw new Error('Owner commitment not confirmed');
        owner = 'shared';
      }
      const selected = owner;
      if (selected === 'legacy') pending++;
      let settled = false;
      return {
        owner: selected,
        finish(completedUpstream) {
          if (settled || selected !== 'legacy') return;
          settled = true;
          pending--;
          lastCompletion = now();
          // An upstream disconnect does not establish that the operation ended.
          if (completedUpstream !== true) observed = false;
        },
      };
    },
  };
}
module.exports = { trackFamily };
