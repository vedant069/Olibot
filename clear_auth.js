import Database from 'better-sqlite3';
const db = new Database('/home/ubuntu/whatsapp-engineer/sessions.db');
db.exec(`
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS auth_otps;
    DROP TABLE IF EXISTS access_requests;
    DROP TABLE IF EXISTS session_collaborators;
`);
const result = db.prepare('SELECT count(*) as count FROM sessions').get();
console.log(result.count + ' sessions preserved, auth tables cleared.');
