# Back-end for Open PIM Project

[Open PIM](https://www.openpim.org) - free and open source Product Information Management system.

# Quick start for a Demo setup.
1. Clone the repo
2. Switch to `docker` folder
3. Run the command
```bash
    docker-compose -f docker-compose.yaml up --remove-orphans -d
```
4. console will be available by visiting [http://localhost:8080](http://localhost:8080)
5. Login with Username as `admin` Password as `admin` for an administrator view.

There is no other user, you can create a user called `demo` with password as `demo` from the admin console.

# Quick start in Ubuntu 20 cloud server
The following example cloud config file shows how you can deploy OpenPim on an Ubuntu 20.04 cloud server.
Don't forget to replace the ssh key and database password

```yaml
#cloud-config
users:
  - name: pim
    ssh-authorized-keys:
      - ssh-rsa AAA....
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    groups: sudo
    shell: /bin/bash
ssh_pwauth: false
disable_root: true

packages:
  - ca-certificates
  - curl
  - gnupg
  - lsb-release
  - postgresql 
  - postgresql-contrib
  - ufw

package_update: true
# package_upgrade: true
  
write_files:
  - content: |
      listen_addresses = '*'
    path:
      /etc/postgresql/12/main/conf.d/01pim.conf  

runcmd:
  # install docker
  - mkdir -p /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  - echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  - apt-get update
  - apt-get install docker-ce docker-ce-cli containerd.io docker-compose-plugin
  # configure postgres
  - echo "host all all 0.0.0.0/0 md5" >> /etc/postgresql/12/main/pg_hba.conf  
  - sudo -u postgres psql -U postgres --command="ALTER USER postgres WITH PASSWORD '123';"
  - systemctl restart postgresql.service
  # configure firewall
  - ufw allow 22
  - ufw allow 80  
  - ufw enable
  # install openpim
  - curl -O https://openpim.org/sql/init.sql
  - sudo -u postgres psql -U postgres -d postgres < init.sql
  # run docker as network host mode
  - docker run -d --network=host -v /mnt:/filestorage --env OPENPIM_DATABASE_ADDRESS=127.0.0.1 --env OPENPIM_DATABASE_NAME=postgres --env OPENPIM_DATABASE_USER=postgres --env OPENPIM_DATABASE_PASSWORD=123 openpim/production:1.5
hostname: localhost
prefer_fqdn_over_hostname: false
```
