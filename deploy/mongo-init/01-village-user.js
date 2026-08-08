// Creates the Chronicle's scoped user on first initialisation only.
//
// The root credential exists to create this one and is then used by nothing --
// a break-glass account, matching the convention on the rest of this host. The
// village authenticates as mcs_village and can touch exactly one database.
//
// dbAdmin is required, not decorative: the Chronicle declares its own indexes
// through mongoose autoIndex, and plain readWrite cannot create them.
//
// Runs only when /data/db is empty. Changing this file does not affect an
// existing volume -- create the user by hand if it ever needs changing.
db = db.getSiblingDB('mcs-village');
db.createUser({
    user: 'mcs_village',
    pwd: process.env.CHRONICLE_VILLAGE_PASSWORD,
    roles: [
        { role: 'readWrite', db: 'mcs-village' },
        { role: 'dbAdmin',   db: 'mcs-village' },
    ],
});
