-- One-time additive seed for an existing Cloudflare D1 BookHarbor database.
-- All prices, formats and stock are fictional values for this academic demo.
-- INSERT OR IGNORE keeps existing product records and previous stock unchanged.
INSERT OR IGNORE INTO products(id,title,author,category,price,stock,edition,color,aliases) VALUES
('mis-digital-firm','Management Information Systems: Managing the Digital Firm','Kenneth C. Laudon, Jane P. Laudon','Management Information Systems',1890,8,'Sample paperback','forest','management information systems managing the digital firm,managing the digital firm,laudon mis,digital firm textbook,ম্যানেজমেন্ট ইনফরমেশন সিস্টেমস ম্যানেজিং দ্য ডিজিটাল ফার্ম'),
('mis-business-driven','Business Driven Information Systems','Paige Baltzan, Amy Phillips','Management Information Systems',1490,10,'Sample paperback','indigo','business driven information systems,business driven info systems,business driven information,business driven mis,বিজনেস ড্রিভেন ইনফরমেশন সিস্টেমস'),
('mis-today','Information Systems Today: Managing in the Digital World','Joseph S. Valacich, Christoph Schneider, Matthew Hashim','Management Information Systems',1590,7,'Sample paperback','sky','information systems today managing in the digital world,information systems today,managing in the digital world,ইনফরমেশন সিস্টেমস টুডে'),
('mis-m-baltzan','M: Information Systems','Paige Baltzan','Management Information Systems',1190,12,'Sample paperback','ochre','m information systems,m information systems baltzan,m is textbook,এম ইনফরমেশন সিস্টেমস');
