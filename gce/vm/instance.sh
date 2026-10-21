#!/bin/bash
# A job VM's own setup at boot, in place of what cloud-init did there (the image disables cloud-init: spec M3, The
# boot), run by ci-kit-gce-instance.service before the job unit. It grows the root partition and filesystem to the
# VM's disk (the image is the builder's 30 GB disk; a job VM's is disk_gb) and names the host after the instance.
# Network and DNS come from the image's netplan (DHCP), the metadata server and guest attributes from the guest agent.
set -euo pipefail
part=$(findmnt -no SOURCE /)
disk=/dev/$(lsblk -no PKNAME "$part")
number=$(cat "/sys/class/block/${part#/dev/}/partition")
if out=$(growpart "$disk" "$number" 2>&1); then
  resize2fs "$part"
else
  case $out in
    NOCHANGE*) ;; # the root already fills the disk
    *) echo "$out" >&2; exit 1 ;;
  esac
fi
name=$(curl -sf --retry 5 --retry-connrefused --max-time 10 -H 'Metadata-Flavor: Google' \
  http://169.254.169.254/computeMetadata/v1/instance/name)
hostnamectl set-hostname "$name"
echo "ci-kit instance: root $(df -h --output=size / | tail -1 | tr -d ' ') on $disk, hostname $(hostname)"
