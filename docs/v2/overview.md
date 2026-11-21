# Overview

## Purpose

Server Status is a self-hosted **public status page**. An organisation lists the
services it runs (website, API, mail, …), optionally grouped, and staff post
**incidents** that change the displayed status of those services. Visitors see
the current state of every service plus a timeline of past incidents and upcoming
planned maintenance. Visitors can **subscribe** by email or Telegram and get a
notification when an incident affects a service they follow.

Project goals stated in the README, which the rewrite should keep in mind:

- Runs on **cheap shared web hosting**, without shell access.
- Installs by uploading files and following a **web installer**.
- The public page **works without JavaScript**.

## Actors

| Actor | Description |
| --- | --- |
| **Visitor** | Anonymous user viewing the public status page, API consumer, or privacy policy reader. |
| **Subscriber** | Visitor who signed up for notifications through email (`typeID = 2`) or Telegram (`typeID = 1`). Identified by a token (email) or a Telegram login (session). Has no password. |
| **Editor** (rank 2) | Staff user. Can post incidents and delete their own. |
| **Admin** (rank 1) | Editor plus: manage services and service groups, delete any incident, activate or deactivate users with a lower rank. |
| **Super admin** (rank 0) | Admin plus: create users, change roles, edit other users' names, usernames and emails. Created by the installer. |
| **Cron caller** | External scheduler calling `/admin/?task=cron` from a whitelisted IP to process the notification queue. |
| **Installer** | Person running the first-time web installer. |

The Options page has **no rank check at all** in practice. Any logged-in user can
change global options, and so can unauthenticated users (see the v2 security review, which is not published).

## Use cases

### Public

1. **View current status.** See an overall banner ("All systems operational",
   "Some systems are experiencing minor outages", …) and the status of each
   service, grouped by service group, with a tooltip for each service description.
2. **View incident history.** Read past incidents (Markdown body, affected services,
   author, start time, end time), 5 at a time, with "Load more" (AJAX, or plain links
   when JavaScript is off).
3. **View planned maintenance.** Upcoming and ongoing maintenance windows are listed
   separately above past incidents.
4. **Switch language.** Use the language selector in the footer (`?lang=xx_XX`).
   The default comes from the browser's `Accept-Language` header.
5. **Read privacy policy / imprint.** Open `policy.php`, generated from values
   entered during install, or an external URL.
6. **Query status programmatically.** Use the JSON API for the status of all services,
   a single service, and incidents.

### Subscriber

7. **Subscribe by email.** Enter an address. The domain must have an MX record,
   with optional reCAPTCHA. The visitor receives a link that must be opened within
   2 hours to activate the subscription.
8. **Subscribe by Telegram.** Log in with the Telegram widget. The subscriber is
   created and activated immediately.
9. **Manage subscriptions.** Pick which services to follow, and add or remove them.
10. **Receive notifications.** When an incident is posted for a followed service,
    receive an email (HTML template) or a Telegram message from the bot.
11. **Unsubscribe.** Use the link in the email or the subscriptions page. This
    deletes the subscriber and all their subscriptions.
12. **Log out** (subscriber session).

### Staff (admin panel, `/admin`)

13. **Log in** with email and password, with an optional "remember me" for about one year.
14. **Reset a forgotten password** through an emailed one-time link valid for 24 h.
15. **Post an incident.** Choose a type (major outage, minor outage, planned
    maintenance, operational), title, Markdown text and affected services. Maintenance
    needs a start and end time. This triggers subscriber notifications.
16. **Delete an incident.**
17. **Manage services.** Create, edit or delete a service, with name, description and group.
18. **Manage service groups.** Create, edit or delete a group, with name, description
    and a visibility setting (which is stored but has no effect).
19. **Manage users.** Create a user (the generated password is emailed), change a role,
    or activate/deactivate a user.
20. **Edit own profile.** Change name, username, email (confirmed by email link) and
    password (requires the old password).
21. **Configure options.** Site name, email/Telegram subscriptions on or off, Telegram
    bot credentials, mail transport (PHP `mail()` or PHPMailer/SMTP), cron server IP,
    reCAPTCHA keys, update notification flag.

### Operations

22. **Install** through the web installer. It checks prerequisites, creates the
    database schema and the first super admin, writes `config.php`, and generates
    `.htaccess` or `web.config`.
23. **Process the notification queue**, either right after an incident is posted or
    from cron.
24. **Upgrade** by hand: replace the files, keep `config.php`, and run SQL manually.
    There is no migration runner.
