# Written answers for three technical questions 


## Questions_1

A service stores user names in users.display_name. A proposed release introduces users.full_name, changes all application reads and writes to the new column, and drops display_name in the same deployment. The service uses rolling deployment, so old and new application instances run concurrently. The release must also support rollback. Explain why this release can fail and propose a safe sequence of database and application changes.

## Answer_1

### why this release can fail

When we use the rolling deployment, both the old and new pod will rely the same SQL schema. Drop the column will make the old pod fail to manipulate table - 'cause these's no display_name column'. And roll back will become fail.

### How to propose a safe sequence of database and application changes.

We'd like to seperate special status to solve this problem. Drop a column is a big deal!
STATUS_1: Add column and let the new write to the both new column and old column, make these same data.
STATUS_2: replace the read to the new column - 'full name'
STATUS_3: replace the write to the new column
STATUS_4: Drop the table

And we need time between the two status, to avoid other problem.

## Questions_2

Certificate details are cached for 60 seconds. Request A misses the cache and reads ACTIVE from the database. Before A writes to the cache, request B revokes the certificate, commits the database transaction, and deletes the cache entry. A then writes its stale ACTIVE value into the cache. A colleague proposes reducing the cache TTL to five seconds. Explain why this does not fix the problem. Redesign the read and revocation paths so that any read starting after B returns success cannot receive the stale ACTIVE value.

## Answer_2

### Explain why this does not fix the problem.

There may be net lag or something. If A pending for about 2 second, in this period the B will still revokes the certificate.  

### Redesign things

Pretend to use the version id, use rev make the data to be know if was modified.
we cache the {status, rev} if we write the cache, we +1 to the rev
and if we read the cache find  now.rev >= cache.rev we return. otherwise we treat this as MISS.

## Questions_3

Service A has 50 request workers. Every request to its /report endpoint calls Service B with a 100 ms timeout and up to three retries. Traffic to /report remains at 1,000 requests per second. B's latency suddenly rises from 20 ms to 2 seconds, and unrelated endpoints on A soon stop responding. Explain the chain of failure, including the effect of retries. Redesign /report so unrelated endpoints remain available, and state what /report should return when B is unhealthy.

## Answer_3

### Explain the chain of failure

retry will make one worker take 300-400ms. And the container for 50 worker will become 150 rps and we need 1000 rps. So there will be 850 rps increase for request queue and the queue not have bound. 
There will be a jam and continue growing and lead the servie down.

### Redesign /report


- we only retry the 5xx/429 things, we don't retry latency things.
- we can set the break mechanism, once we detect the error rate like > 50% we need report and limit the request.
- we need boundary queue to request, once the requests are out of bound we can throw or take other method to gurantee the usable of the sevice.



### what /report should return when B is unhealthy.

use 429 for the overload like the queue is full 
use 200 for the success
use 504 for the gateway break.
use 503 for the break mechanism.