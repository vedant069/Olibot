import Database from 'better-sqlite3';
import crypto from 'crypto';
const db = new Database('/home/ubuntu/whatsapp-engineer/sessions.db');
const salt = 'wa-engineer-salt-2025';
const pass = 'Admin@2025';
const hash = crypto.createHash('sha256').update(salt + pass).digest('hex');
const id = crypto.randomUUID();
try {
    db.prepare('DELETE FROM users WHERE email=?').run('vedantnadhe069@gmail.com');
    db.prepare('INSERT INTO users (id,email,display_name,role,is_admin,password_hash) VALUES (?,?,?,?,?,?)').run(id, 'vedantnadhe069@gmail.com', 'Admin', 'admin', 1, hash);
    console.log('✅ Admin user created! Email: vedantnadhe069@gmail.com | Password: Admin@2025');
} catch (e) {
    console.log('Error creating admin: ' + e.message);
}
