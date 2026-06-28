const CANCELLED_AT_MS = Date.UTC(2019, 8, 16, 0, 0, 0);
const RUMBLE_MS = 900;
const ROLL_MS = 6200;
const MAX_PARTICLES = 70;

export function createSealedStoneModal({ dom, onFindDate }) {
  let phase = "sealed";
  let revealStartedAt = 0;
  let phaseTimers = [];
  let rimDustInterval = null;
  let groundSmokeInterval = null;
  const particleNodes = [];
  const particleTimers = new Set();

  const stone = dom.sealedStoneScene.querySelector(".ssm-stone");
  const days = dom.sealedStoneCard.querySelector("[data-stone-days]");
  const hours = dom.sealedStoneCard.querySelector("[data-stone-hours]");
  const minutes = dom.sealedStoneCard.querySelector("[data-stone-minutes]");
  const seconds = dom.sealedStoneCard.querySelector("[data-stone-seconds]");
  const counter = dom.sealedStoneCard.querySelector("[data-stone-counter]");
  const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function clearParticleIntervals() {
    if (rimDustInterval !== null) clearInterval(rimDustInterval);
    if (groundSmokeInterval !== null) clearInterval(groundSmokeInterval);
    rimDustInterval = null;
    groundSmokeInterval = null;
  }

  function clearParticles() {
    particleTimers.forEach(clearTimeout);
    particleTimers.clear();
    particleNodes.splice(0).forEach((node) => node.remove());
  }

  function clearMotion() {
    phaseTimers.forEach(clearTimeout);
    phaseTimers = [];
    clearParticleIntervals();
  }

  function updateCounter() {
    let remaining = Math.max(0, Math.floor((Date.now() - CANCELLED_AT_MS) / 1000));
    const elapsedDays = Math.floor(remaining / 86400);
    remaining -= elapsedDays * 86400;
    const elapsedHours = Math.floor(remaining / 3600);
    remaining -= elapsedHours * 3600;
    const elapsedMinutes = Math.floor(remaining / 60);
    const elapsedSeconds = remaining - (elapsedMinutes * 60);

    days.textContent = elapsedDays.toLocaleString("en-US");
    hours.textContent = String(elapsedHours).padStart(2, "0");
    minutes.textContent = String(elapsedMinutes).padStart(2, "0");
    seconds.textContent = String(elapsedSeconds).padStart(2, "0");
    counter.setAttribute(
      "aria-label",
      `${elapsedDays.toLocaleString("en-US")} days, ${elapsedHours} hours, ${elapsedMinutes} minutes, and ${elapsedSeconds} seconds since cancellation`,
    );
  }

  function updateRollDistance() {
    const distance = (dom.sealedStoneScene.clientWidth / 2) + (stone.offsetWidth * 0.404);
    dom.sealedStoneScene.style.setProperty("--ssm-roll-x", `${distance}px`);
  }

  function syncPhase() {
    dom.sealedStoneScene.dataset.phase = phase;
    const moving = phase === "rumble" || phase === "rolling";
    const revealed = phase === "open";

    dom.sealedStoneScene.setAttribute(
      "aria-label",
      revealed
        ? "The stone has rolled aside, revealing the time since cancellation. Activate the scene to reseal it."
        : moving
          ? "The sealed stone is rolling aside. Activate the scene to reseal it."
          : "A sealed stone blocks the doorway. Activate it to open the archive calendar and find the day that rolls it aside.",
    );
    dom.sealedStoneAction.disabled = false;
    dom.sealedStoneAction.hidden = phase !== "sealed";
    dom.sealedStoneAction.textContent = "▸ Find the date · 16 Sept 2019";
  }

  function setPhase(nextPhase) {
    phase = nextPhase;
    syncPhase();
  }

  function trimParticles() {
    while (particleNodes.length > MAX_PARTICLES) {
      particleNodes.shift()?.remove();
    }
  }

  function scheduleParticleRemoval(node, duration, buffer) {
    const timer = setTimeout(() => {
      particleTimers.delete(timer);
      const index = particleNodes.indexOf(node);
      if (index >= 0) particleNodes.splice(index, 1);
      node.remove();
    }, duration + buffer);
    particleTimers.add(timer);
  }

  function getStonePosition() {
    const rollElapsed = Math.max(0, Date.now() - revealStartedAt - RUMBLE_MS);
    const progress = Math.min(1, rollElapsed / ROLL_MS);
    const eased = progress * progress * (2 - progress);
    const rollDistance = (dom.sealedStoneScene.clientWidth / 2) + (stone.offsetWidth * 0.404);
    return {
      cx: (dom.sealedStoneScene.clientWidth / 2) + (rollDistance * eased),
      cy: dom.sealedStoneScene.clientHeight - 4 - (stone.offsetWidth / 2) + (14 * eased),
      radius: stone.offsetWidth * 0.48,
    };
  }

  function spawnRimDust() {
    if (phase !== "rumble" && phase !== "rolling") return;
    const { cx, cy, radius } = getStonePosition();
    const angle = phase === "rumble"
      ? Math.random() * Math.PI * 2
      : (Math.PI * 0.75) + (Math.random() * Math.PI * 1.5);
    const x = cx + (Math.cos(angle) * radius);
    const y = cy + (Math.sin(angle) * radius);
    if (y > dom.sealedStoneScene.clientHeight - 60) return;

    const size = 2 + (Math.random() * 5);
    const fall = 30 + (Math.random() * 48);
    const drift = (Math.random() - 0.5) * 16;
    const duration = 450 + (Math.random() * 650);
    const alpha = 0.55 + (Math.random() * 0.38);
    const blur = 0.4 + (Math.random() * 1.8);
    const particle = document.createElement("span");
    particle.className = "ssm-particle ssm-particle--dust";
    particle.setAttribute("aria-hidden", "true");
    particle.style.left = `${x - (size / 2)}px`;
    particle.style.top = `${y - (size / 2)}px`;
    particle.style.width = `${size}px`;
    particle.style.height = `${size}px`;
    particle.style.setProperty("--dx", `${drift}px`);
    particle.style.setProperty("--fall", `${fall}px`);
    particle.style.setProperty("--particle-duration", `${duration}ms`);
    particle.style.setProperty("--particle-blur", `${blur}px`);
    particle.style.background = `radial-gradient(circle, rgba(212, 188, 148, ${alpha}) 20%, rgba(180, 155, 112, ${alpha * 0.4}) 70%, transparent 100%)`;
    dom.sealedStoneScene.appendChild(particle);
    particleNodes.push(particle);
    trimParticles();
    scheduleParticleRemoval(particle, duration, 120);
  }

  function spawnGroundSmoke() {
    if (phase !== "rolling") return;
    const { cx } = getStonePosition();
    const size = 18 + (Math.random() * 40);
    const x = cx + ((Math.random() - 0.5) * 78);
    const y = (dom.sealedStoneScene.clientHeight - 54) - (size * 0.28);
    const duration = 950 + (Math.random() * 1100);
    const alpha = 0.1 + (Math.random() * 0.1);
    const spread = (Math.random() - 0.5) * 52;
    const blur = 8 + (Math.random() * 10);
    const particle = document.createElement("span");
    particle.className = "ssm-particle ssm-particle--smoke";
    particle.setAttribute("aria-hidden", "true");
    particle.style.left = `${x - (size / 2)}px`;
    particle.style.top = `${y - (size / 2)}px`;
    particle.style.width = `${size}px`;
    particle.style.height = `${size}px`;
    particle.style.setProperty("--sx", `${spread}px`);
    particle.style.setProperty("--particle-duration", `${duration}ms`);
    particle.style.setProperty("--particle-blur", `${blur}px`);
    particle.style.background = `radial-gradient(circle, rgba(172, 158, 136, ${alpha}) 0%, rgba(140, 126, 106, ${alpha * 0.5}) 55%, transparent 85%)`;
    dom.sealedStoneScene.appendChild(particle);
    particleNodes.push(particle);
    trimParticles();
    scheduleParticleRemoval(particle, duration, 200);
  }

  function resetStone({ withoutMotion = false } = {}) {
    clearMotion();
    clearParticles();
    if (withoutMotion) dom.sealedStoneCard.classList.add("is-resetting");
    setPhase("sealed");
    updateRollDistance();
    if (withoutMotion) {
      void dom.sealedStoneScene.offsetWidth;
      dom.sealedStoneCard.classList.remove("is-resetting");
    }
  }

  function reveal() {
    if (phase !== "sealed") return;
    revealStartedAt = Date.now();
    updateCounter();
    updateRollDistance();

    if (prefersReducedMotion()) {
      setPhase("open");
      return;
    }

    setPhase("rumble");
    rimDustInterval = setInterval(spawnRimDust, 75);
    phaseTimers = [
      setTimeout(() => {
        setPhase("rolling");
        if (rimDustInterval !== null) clearInterval(rimDustInterval);
        rimDustInterval = setInterval(spawnRimDust, 110);
        spawnGroundSmoke();
        groundSmokeInterval = setInterval(spawnGroundSmoke, 80);
      }, RUMBLE_MS),
      setTimeout(() => {
        clearParticleIntervals();
        setPhase("open");
      }, RUMBLE_MS + ROLL_MS),
    ];
  }

  function reseal() {
    if (phase === "sealed") return;
    clearMotion();
    clearParticles();
    setPhase("sealed");
  }

  function findDate() {
    if (phase !== "sealed") return;
    onFindDate?.(dom.sealedStoneAction);
  }

  function toggleScene() {
    if (phase === "sealed") findDate();
    else reseal();
  }

  function open() {
    resetStone({ withoutMotion: true });
    updateCounter();
    dom.sealedStoneCard.classList.remove("is-summoned");
    void dom.sealedStoneCard.offsetWidth;
    dom.sealedStoneCard.classList.add("is-summoned");
    dom.sealedStoneCard.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "center",
    });
    dom.sealedStoneScene.focus({ preventScroll: true });
    reveal();
  }

  dom.sealedStoneScene.addEventListener("click", toggleScene);
  dom.sealedStoneScene.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleScene();
  });
  dom.sealedStoneAction.addEventListener("click", findDate);
  window.addEventListener("resize", updateRollDistance);
  setInterval(updateCounter, 1000);
  updateCounter();
  updateRollDistance();
  syncPhase();

  return { open, reveal, reseal };
}
