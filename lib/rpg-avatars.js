/**
 * lib/rpg-avatars.js — RPG Avatar Manifest
 *
 * Single source of truth for selectable avatars.
 * Used by both server.js (API validation) and frontend (picker UI).
 *
 * Each avatar has:
 *   id    — SMALLINT stored in profiles.rpg_avatar_id (DB CHECK: 2-8)
 *   label — short archetype name (displayed under the pixel-art image)
 *   src   — public URL path to the 1024x1024 pixel-art PNG
 *   theme — CSS theme key (rpg-theme--{theme} on #rpg-screen)
 *   flavor — short SK copy for sidebar / header (lore + mood)
 *
 * Avatar 1 is a sprite sheet (18 characters) — excluded from selection.
 */

'use strict';

/** gIVEMECOIN cost to pick or switch avatar (first pick included). Deselect (null) is free. */
const RPG_AVATAR_SWITCH_COST = 5000;

const RPG_AVATARS = [
  {
    id: 2,
    label: 'Scholar',
    src: '/avatars/2.png',
    theme: 'scholar',
    flavor: 'Knihy, čísla a ticho knižnice — analytik, ktorý spája fakty do vízie.',
  },
  {
    id: 3,
    label: 'Builder',
    src: '/avatars/3.png',
    theme: 'builder',
    flavor: 'Teplo dielne a iskry — staviaš, skladáš a meníš nápady na skutočné veci.',
  },
  {
    id: 4,
    label: 'Healer',
    src: '/avatars/4.png',
    theme: 'healer',
    flavor: 'Jemné svetlo a starostlivosť — podporuješ druhých a držíš skupinu pokope.',
  },
  {
    id: 5,
    label: 'Shadow',
    src: '/avatars/5.png',
    theme: 'shadow',
    flavor: 'Ticho, maska a fialový šero — rýchly, nepredvídateľný, presný ako úder v tme.',
  },
  {
    id: 6,
    label: 'Alchemist',
    src: '/avatars/6.png',
    theme: 'alchemist',
    flavor: 'Bubliny a vzorce — miešaš experimenty, meníš pravidlá a hľadáš nové výsledky.',
  },
  {
    id: 7,
    label: 'Sage',
    src: '/avatars/7.png',
    theme: 'sage',
    flavor: 'Zlato, pergamene a pokoj — múdry sprievodca, ktorý vidí súvislosti medzi svetmi.',
  },
  {
    id: 8,
    label: 'Knight',
    src: '/avatars/8.png',
    theme: 'knight',
    flavor: 'Oceľ, česť a čelný postoj — chrániš pravidlá, tím a cieľ bez zbytočných slov.',
  },
];

const VALID_AVATAR_IDS = RPG_AVATARS.map(a => a.id);

/**
 * Check if an avatar_id is valid for selection.
 * @param {number|null} id — avatar ID or null (deselect)
 * @returns {boolean}
 */
function isValidAvatarId(id) {
  return id === null || VALID_AVATAR_IDS.includes(id);
}

/**
 * Get the full avatar manifest array (safe to send to client).
 * @returns {Array<{id: number, label: string, src: string, theme: string, flavor: string}>}
 */
function getAvatarManifest() {
  return RPG_AVATARS;
}

/**
 * @param {number} id
 * @returns {object | null}
 */
function getAvatarById(id) {
  if (id == null || id === undefined) return null;
  return RPG_AVATARS.find(a => a.id === id) || null;
}

/**
 * Roles allowed to access the RPG avatar system.
 * Must match Sprint 1 SPRINT1_ROLES in edu-routes.js.
 */
const RPG_ELIGIBLE_ROLES = ['admin', 'teacher', 'student'];

module.exports = {
  RPG_AVATARS,
  VALID_AVATAR_IDS,
  RPG_ELIGIBLE_ROLES,
  RPG_AVATAR_SWITCH_COST,
  isValidAvatarId,
  getAvatarManifest,
  getAvatarById,
};
