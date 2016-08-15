// Copyright 2015, EMC, Inc.

'use strict';

module.exports = {
    friendlyName: 'Bootstrap Ubuntu',
    injectableName: 'Task.Linux.Bootstrap.Ubuntu',
    implementsTask: 'Task.Base.Linux.Bootstrap',
    options: {
        kernelFile: 'vmlinuz-4.1.15-diag',
        initrdFile: 'ramfs.lzma',
        kernelUri: '{{ api.server }}/common/{{ options.kernelFile }}',
        initrdUri: '{{ api.server }}/common/{{ options.initrdFile }}',
        basefs: 'common/base.trusty.3.16.0-25-generic.squashfs.img',
        overlayfs: 'common/discovery.overlay.cpio.gz',
        profile: 'linux.ipxe',
        comport: 'ttyS0',
        kargs: {
            overlay_url: '{{ api.server }}/common/dod-docker-daemon.cpio.gz',
            acpi: 'off',
            SYSRESET: 'no'
        }
    },
    properties: {
        os: {
            linux: {
                distribution: 'ubuntu',
                release: 'trusty',
                kernel: '3.16.0-25-generic'
            }
        }
    }
};
