---
title: Roles and access
sidebar_position: 3
description: Who can see and do what in Volt, the default roles, and how to make your own.
---

# Roles and access

Every admin user's access comes from their **roles**. A role gives a **level** in each area of Volt. A user with several roles gets the highest level any of them gives. **Admin > Permissions map** in the console shows the live map for your account, including any roles you have made (see [Permissions map](../guides/permissions-map.md)).

## Levels

| Level | Allows |
|---|---|
| **None** | Nothing. The area is hidden in the console. |
| **View** | See lists and pages |
| **Operate** | Run things without changing their settings: start, stop, go on air, publish, retry |
| **Manage** | Everything, including create, edit and remove |

## Kinds of user

| User type | In short |
|---|---|
| **Owner** | Everything in the account |
| **Administrator** | Everything in the account except changing the plan |
| **Event Manager** | Creates, schedules and runs events, their guides and recordings, and publishes the results |
| **Graphics Operator** | Runs graphics live: takes them on and off, changes scores and names, works event rundowns. Cannot change templates or setups. |
| **Radio Manager** | Creates, configures and runs radio stations, their schedules and clips |
| **Report and Analytics Manager** | Analytics and reports. Sees content and usage, cannot change or run it. |
| **System Viewer** | Reads everything in the console, changes nothing, starts nothing |
| **Public user** | Watches through your apps and players. Never reaches the console. |

## Default levels by area

| Area | Owner and Administrator | Event Manager | Graphics Operator | Radio Manager | Report and Analytics | System Viewer |
|---|---|---|---|---|---|---|
| Live and monitoring | Manage | View | View | View | View | View |
| TV channels | Manage | View | View | None | View | View |
| Radio stations | Manage | None | None | Manage | View | View |
| Events | Manage | Manage | View | None | View | View |
| EPG and schedules | Manage | Manage | View | Manage | View | View |
| Graphics | Manage | Manage | Operate | None | View | View |
| Recordings and clips | Manage | Manage | None | Manage | View | View |
| Media library and publishing | Manage | Operate | None | None | View | View |
| Files, uploads and storage | Manage | Manage | View | Manage | View | View |
| Share links | Manage | Manage | None | Manage | View | View |
| Analytics and reports | Manage | View | None | View | Manage | View |
| Fleet and usage | Manage | None | None | None | View | View |
| Admin users | Manage | None | None | None | None | View |
| Roles and access | Manage | None | None | None | None | View |
| Public users | Manage | None | None | None | View | View |
| Apps, API keys and players | Manage | None | None | None | None | View |
| Payments and products | Manage | None | None | None | None | View |
| Account settings | Manage | None | None | None | None | View |

## Account controls

Some actions depend on the kind of user rather than a level:

| Action | Owner | Administrator | Other roles |
|---|---|---|---|
| Change the plan | Depends on your agreement | View only | View only, with Account settings |
| Set the account logo and colours | Yes | Yes | View only, with Account settings |
| Remove channels and radio stations | Yes | Yes | No |
| Remove events | Yes | Yes | With Events: Manage |
| Read the [audit log](../guides/audit-log.md) | Yes | Yes | No |
| Add users and give roles | Yes | Yes | With Admin users: Manage, and only up to their own access |

## Making your own roles

Go to **Admin > Users & Roles > Roles > New role** (see [Users & Roles](../guides/users-and-roles.md)). Give the role a name, a tier and a level per area:

- **Operator** tier: any level up to Manage.
- **Viewer** tier: everything is capped at View.

A role gives exactly what it lists. Every other area is None, and the console hides what the role does not include. You cannot give a role more access than you hold yourself.

### Start from a template

The New role form offers starting points. They fill in the form, which you can still edit.

| Template | Gives |
|---|---|
| EPG Administrator | EPG and schedules: Manage |
| Channel Operator | Live and monitoring: View. TV, radio and events: Operate. EPG and recordings: View. |
| Clip Editor | Recordings: Manage. Media library: Operate. Files: View. Share links: Manage. Monitoring and EPG: View. |
| Media Librarian | Files and Media library: Manage. Recordings: View. Share links: Manage. |
| Viewer Support | Public users: Operate. Analytics and monitoring: View. |

### Example: an EPG Administrator

With only **EPG and schedules: Manage**, a user:

- sees only EPG (and their notifications) in the menu, and lands on it when they sign in.
- creates and edits guides for channels, stations and events, and adds, copies and removes programmes.
- sets guide icons and XMLTV ids, creates XMLTV export feeds and import sources, and runs imports.
- cannot list, create, start or remove channels, stations, events or recordings.
- cannot see users, roles or the audit log, or change groups or the plan.
- can browse the image library to pick icons, but needs **Files** to upload.

## Two-step sign-in

Owners and administrators can require two-step sign-in for every admin user in the account (**Users & Roles**, **Require two-step sign-in for all admin users**). Users can sign in with an authenticator app, an emailed code or a texted code, and get backup codes when they turn it on. If someone loses their phone, an administrator can reset their two-step sign-in.
