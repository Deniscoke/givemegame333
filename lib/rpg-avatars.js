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
 *
 * Avatar 1 is a sprite sheet (18 characters) — excluded from selection.
 *
 * Future fields (reserved, not yet populated):
 *   animClass  — CSS class for avatar-specific idle animation
 *   sfx        — { select, levelUp } sound file paths
 *   trait      — RPG trait description (e.g. "+10% XP from solo games")
 */

'use strict';

const RPG_AVATARS = [
  { id: 2, label: 'Scholar',   src: '/avatars/2.png' },
  { id: 3, label: 'Builder',   src: '/avatars/3.png' },
  { id: 4, label: 'Healer',    src: '/avatars/4.png' },
  { id: 5, label: 'Shadow',    src: '/avatars/5.png' },
  { id: 6, label: 'Alchemist', src: '/avatars/6.png' },
  { id: 7, label: 'Sage',      src: '/avatars/7.png' },
  { id: 8, label: 'Knight',    src: '/avatars/8.png' },
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
 * @returns {Array<{id: number, label: string, src: string}>}
 */
function getAvatarManifest() {
  return RPG_AVATARS;
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
  isValidAvatarId,
  getAvatarManifest,
};
