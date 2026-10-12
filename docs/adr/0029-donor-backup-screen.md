# Donor init shows the 25 words once, before it saves the key file

This ADR supersedes one part of ADR 0016: "It never prints the mnemonic" and the rejection of
printing the mnemonic for the donor to copy. The rest of ADR 0016 stays.

On a terminal, `aupm donor init` first saved the key file and then asked the donor to copy the 25
words from the file to paper. In the dry run of 2026-10-12, a Ctrl-C at the backup prompt kept
the file. The next `init` continued from the file and did not ask for the backup again. A donor
could then fund a wallet that had no backup.

On a terminal (stdin and stdout are terminals, no `--yes`), `init` now does these steps:

1. It makes the key in memory. It saves nothing.
2. It shows the 25 words one time. When the terminal has an alternate screen (`TERM` is not
   `dumb`), the words are on the alternate screen.
3. It asks for `yes`. Any other answer asks again.
4. After `yes`, it leaves the alternate screen and writes the key file (0600, exclusive).
5. A Ctrl-C or a closed input before `yes` saves nothing. The next `init` makes a new key.

The words go to stdout only when stdout is a terminal. Without a terminal, or with `--yes`,
`init` keeps the ADR 0016 behavior: it writes the file first and never prints the words.

The risk that ADR 0016 named stays in part. Most terminals and tmux do not keep the alternate
screen in the scrollback. A session recorder (`script`, asciinema, terminal logging) or a screen
share records the words. The text tells the donor that `init` shows the words only once. The guide
tells the donor not to record or share the screen during `init`.

We rejected a marker in `config.toml` that records the backup. It keeps a funded file possible
before the backup, and it adds a state that can disagree with the file.
