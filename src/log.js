// Loggrader till journald (stdout): "[DEL] text". journalctl -u dispatch-mottagare visar dem.
'use strict';
module.exports = (part) => (...a) => console.log(`[${part}]`, ...a);
