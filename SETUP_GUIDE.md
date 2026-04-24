# Antigravity Setup Guide

This guide provides the necessary commands to install the **Antigravity** package on your Linux system.

## Debian/Ubuntu Based Systems

Follow these steps to add the repository and install the package:

### 1. Add the Repository to sources.list.d

Run the following commands to set up the GPG key and the repository list:

```bash
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://us-central1-apt.pkg.dev/doc/repo-signing-key.gpg | \
  sudo gpg --dearmor --yes -o /etc/apt/keyrings/antigravity-repo-key.gpg

echo "deb [signed-by=/etc/apt/keyrings/antigravity-repo-key.gpg] https://us-central1-apt.pkg.dev/projects/antigravity-auto-updater-dev/ antigravity-debian main" | \
  sudo tee /etc/apt/sources.list.d/antigravity.list > /dev/null
```

### 2. Update the Package Cache

Refresh your package manager's cache:

```bash
sudo apt update
```

### 3. Install the Package

Install the Antigravity package:

```bash
sudo apt install antigravity
```

---

## RPM-Based Systems (Red Hat, Fedora, SUSE)

For RPM-based distributions, ensure you adjust the repository configuration according to your specific package manager (dnf/zypper).

> **Note:** These commands require `sudo` privileges and are intended for use on a local Linux environment.
