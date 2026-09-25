# Glossary

## Adapter

Protocol/product-specific translation between an external system and Lugn's normalized model.

## Baseline desired state

The value requested by a scene, routine, or automation before manual overrides are applied.

## Capability / tool

A typed action or query exposed by Lugn, usable by UI, routines, Home Assistant, buttons, future voice, agents, and models.

## Command ledger

The record of recent commands Lugn has issued, used to match device feedback and avoid confusing self-generated changes with external/manual changes.

## Confirmed empty

A trustworthy conclusion that the room is empty. Different from unknown.

## Continuity

Memory connecting a short absence with the previous room context.

Continuity can preserve logical state even while physical devices are immediately turned off or paused.

## Convergence

The process of repeatedly checking and nudging devices until observed state matches effective desired state, or until a configured timeout/degraded condition is reached.

## Effective desired state

The final target after baseline desired state and valid overrides are combined.

## Fast path

The minimal latency-sensitive path used for actions such as entry/prelight lighting.

## Logical state

Intent/context remembered by Lugn: scene, overrides, media choice, continuity, routine state, etc.

## Observed state

What an adapter/device currently reports.

## Override

A temporary value/ownership created when an intentional external change supersedes an automated baseline.

Prefer property-level overrides where practical.

## Ownership

Which actor or control policy currently has authority over a property, such as automation or user/external control.

## Pending command

A command sent by Lugn whose expected feedback may still arrive.

## Physical state

What devices are actually doing right now, e.g. lights physically off or music paused.

## Prelight

Fast provisional lighting triggered by likely entry before full occupancy is confirmed.

## Scene

A named baseline desired state for a set of lighting properties.

## Scene revision

An identifier for a particular explicit scene application. It helps invalidate stale work and distinguish new scene intent from old retries.

## Suggestion

A contextual prompt offering an action without automatically taking it.

## Unknown presence

Insufficient trustworthy information to claim occupied or empty. Unknown must not be treated as confirmed empty.
