Captured from the lab box (OpenWrt 24.10.8 at 192.168.199.222) so the model
tests run without it. `nft.txt` is the compiled ruleset and acts as ground
truth: fw4 tags every emitted rule with a `!fw4: <name>` comment, which lets
the test confirm the model puts each rule in the chain nftables really used.

Refresh with scripts/capture-fixtures.sh after changing the seeded ruleset.
