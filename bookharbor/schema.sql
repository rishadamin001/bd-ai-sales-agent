PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,title TEXT NOT NULL,author TEXT NOT NULL,category TEXT NOT NULL,price INTEGER NOT NULL,stock INTEGER NOT NULL CHECK(stock>=0),edition TEXT NOT NULL,color TEXT NOT NULL,aliases TEXT NOT NULL);
INSERT OR IGNORE INTO products VALUES
('hobbit','The Hobbit','J. R. R. Tolkien','Fantasy',650,12,'Paperback','sage','hobbit,হবিট'),
('six-crows','Six of Crows','Leigh Bardugo','Fantasy',780,8,'Paperback','indigo','six of crows,six crows,সিক্স অফ ক্রোজ'),
('dead-poets','Dead Poets Society','N. H. Kleinbaum','Fiction',520,10,'Paperback','ochre','dead poets society,dead poets,ডেড পোয়েটস'),
('hunter','Hunter × Hunter Vol. 38','Yoshihiro Togashi','Manga',890,7,'Paperback','coral','hunter,hunter x hunter,হান্টার'),
('flash','Absolute Flash Vol. 1: Of Two Worlds','Jeff Lemire','Comics',1250,5,'Paperback','red','absolute flash,flash,ফ্ল্যাশ'),
('tolkien','The Tolkien Treasury','J. R. R. Tolkien','Box set',2400,3,'Hardcover set','forest','tolkien treasury,tolkien,টলকিন'),
('less','Less','Andrew Sean Greer','Fiction',690,9,'Paperback','sky','less,লেস'),
('watch-me','Watch Me','Tahereh Mafi','Romance',850,0,'Paperback','rose','watch me,ওয়াচ মি'),
-- Academic demo: textbook titles/authors are real; prices, formats and stock are illustrative.
('mis-digital-firm','Management Information Systems: Managing the Digital Firm','Kenneth C. Laudon, Jane P. Laudon','Management Information Systems',1890,8,'Sample paperback','forest','management information systems managing the digital firm,managing the digital firm,laudon mis,digital firm textbook,ম্যানেজমেন্ট ইনফরমেশন সিস্টেমস ম্যানেজিং দ্য ডিজিটাল ফার্ম'),
('mis-business-driven','Business Driven Information Systems','Paige Baltzan, Amy Phillips','Management Information Systems',1490,10,'Sample paperback','indigo','business driven information systems,business driven info systems,business driven information,business driven mis,বিজনেস ড্রিভেন ইনফরমেশন সিস্টেমস'),
('mis-today','Information Systems Today: Managing in the Digital World','Joseph S. Valacich, Christoph Schneider, Matthew Hashim','Management Information Systems',1590,7,'Sample paperback','sky','information systems today managing in the digital world,information systems today,managing in the digital world,ইনফরমেশন সিস্টেমস টুডে'),
('mis-m-baltzan','M: Information Systems','Paige Baltzan','Management Information Systems',1190,12,'Sample paperback','ochre','m information systems,m information systems baltzan,m is textbook,এম ইনফরমেশন সিস্টেমস');
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,state TEXT NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,product_id TEXT NOT NULL,quantity INTEGER NOT NULL,subtotal INTEGER NOT NULL,delivery INTEGER NOT NULL,total INTEGER NOT NULL,details TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,text TEXT NOT NULL,created INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reply TEXT,engine TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT OR IGNORE INTO settings VALUES('paused','false');
CREATE TABLE IF NOT EXISTS locks(id TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS event_status ON events(status,created);
CREATE INDEX IF NOT EXISTS message_conversation ON messages(conversation_id,id);
