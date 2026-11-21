'use strict';

/**
 * RPG membership fields shared by GET /api/rpg/avatar and GET /api/rpg/talents.
 *
 * The client must only say "Nie si členom školy" when the server says so.
 * Before this, both routes always sent eligible:true and role:'player', and the
 * client guessed membership from missing fields (and showed "Bez triedy" or
 * "Prihlás sa" to logged-in users). Now the server sends an explicit flag.
 *
 * Only display data is returned (role label key + school name). Nothing here
 * grants coins, XP or unlocks; the unlock route keeps its own 403 gate.
 */

/**
 * @param {{ role?: string, school_name?: string } | null | undefined} membership
 *   row from _rpgGetMembership (null when the user is not an eligible member)
 * @returns {{
 *   is_school_member: boolean,
 *   membership: { role: string, school_name: string | null } | null,
 *   role: string,
 *   school_name: string | null,
 * }}
 */
function rpgMembershipFields(membership) {
	const isMember = Boolean(membership && membership.role);
	return {
		is_school_member: isMember,
		membership: isMember ? { role: membership.role, school_name: membership.school_name || null } : null,
		role: isMember ? membership.role : 'player',
		school_name: isMember ? membership.school_name || null : null,
	};
}

/**
 * Avatar class shown in the RPG profile. The avatar itself can be bought by any
 * logged-in user (PATCH /api/rpg/avatar is not membership-gated), so the class
 * is shown to everyone who owns one (M13). Talent unlocks stay member-only.
 *
 * @param {{ rpg_avatar_id?: number | null } | null | undefined} profile
 * @returns {number | null}
 */
function rpgDisplayClassId(profile) {
	const raw = profile ? profile.rpg_avatar_id : null;
	if (raw === null || raw === undefined || raw === '') return null;
	const id = Number(raw);
	return Number.isInteger(id) && id > 0 ? id : null;
}

module.exports = { rpgMembershipFields, rpgDisplayClassId };
