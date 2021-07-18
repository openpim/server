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