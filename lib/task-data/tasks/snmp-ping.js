// Copyright 2015, EMC, Inc.

module.exports = {
    "friendlyName": "Ping Snmp",
    "injectableName": "Task.Snmp.Ping",
    "implementsTask": "Task.Base.Snmp.Collect",
    "options": {
        "oids": [
            "SNMPv2-MIB::sysDescr"
        ]
    },
    "properties": {}
};
