# Recovery inventory registration decision

Recovery-inventory enumerators must compose as immutable caller-supplied registry fragments, never via mutable module-global registration or sibling edits to the aggregate.

Why:
- task-00956ac rail explicitly says enumerators are injected ports;
- module-global registration makes behavior import-order dependent and race-prone;
- sibling edits to recovery-inventory.ts/root files create shared-tree ownership collisions;
- daemon task-cf7fb147bd1c47698cbd65c9535370aa is the real composition edge.

Therefore task-00956ac exports a frozen registry constructor/fragment type. Adapter tasks 091c93db and d7da9be4 export fragments from their own paths. The daemon combines them. Comments comment-5a2a5a35201940e09ae8ebf1417e6f44 and comment-688c6b97f191406492de71e1200fb712 record this on both siblings.
