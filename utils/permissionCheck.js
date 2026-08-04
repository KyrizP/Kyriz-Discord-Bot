const { getAuthorizedUsers } = require('./dataManager');

/**
 * Cek apakah user adalah Superadmin (seed user)
 * Superadmin di-hardcode di .env, hanya 1 orang
 */
function isSuperAdmin(userId) {
  return userId === process.env.SUPERADMIN_ID;
}

/**
 * Cek apakah user punya akses config bot
 * Syarat: Superadmin ATAU ada di daftar authorized users
 *
 * PENTING: Ini TIDAK berdasarkan Discord role/admin.
 * Mau dia owner server sekalipun, kalau tidak di-add oleh Superadmin → tidak bisa.
 */
function isAuthorizedUser(guildId, userId) {
  if (isSuperAdmin(userId)) return true;

  const authorizedUsers = getAuthorizedUsers(guildId);
  return authorizedUsers.includes(userId);
}

module.exports = {
  isSuperAdmin,
  isAuthorizedUser,
};
