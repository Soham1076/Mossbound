# Mossbound

A procedural 2D multiplayer survival game with a shared, endless world. It uses only Node.js built-ins, so there is nothing to install.

## Play solo or with a friend

1. On the computer that will host the game, run `start-game.cmd` (or `node server.js`).
2. Open [http://localhost:8080](http://localhost:8080) on that computer.
3. To play solo, choose Easy, Medium, or Hard bot before entering. To play with a friend, leave **Wait for a friend** selected. Put both devices on the same Wi-Fi network; on the second device, open the **LAN address** shown on the host screen. If the address is not shown, use the host computer's local IPv4 address with `:8080` (for example, `http://192.168.1.42:8080`).
4. Allow Node.js through the host computer's private-network firewall if Windows asks.

The game server listens on all network interfaces at port `8080`. Players share the same world and two-minute round. The clock starts when a second player or bot joins. If a friend joins while a bot match is waiting or running, the bot steps aside for the two human players.

After the results appear, either player can choose **Restart game**. This resets the shared world and returns connected devices to the main menu with a fresh timer and empty packs.

## Controls

- **WASD** or **arrow keys** — move
- **I** — attack the nearest player or resource
- **O** — collect nearby drops
- **P** — emote (“Yeah!” / “GG”)
- Touch devices also get an on-screen movement pad and action buttons.

Wood and stone increase your attack damage. Attacks can knock a resource out of another player; a defeated player's remaining pack drops where they fell. Collect gold and diamonds to win when the two-minute round ends. Players respawn after three seconds near their fall point.

## Run from a terminal

```sh
node server.js
```

Then visit `http://localhost:8080`. Stop the host with **Ctrl+C**.
